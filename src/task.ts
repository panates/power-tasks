import * as os from 'os';
import { AsyncEventEmitter } from 'strict-typed-events';
import _debug from 'debug';
import { plural } from './utils.js';

const debug = _debug('power-tasks:task');

export type TaskFunction<T = any> = (args: TaskFunctionArgs) => T | Promise<T>;
export type TaskLike<T = any> = Task<T> | TaskFunction;
export type TaskStatus = 'idle' | 'waiting' | 'running' | 'fulfilled' | 'failed' | 'aborting' | 'aborted';

export interface TaskFunctionArgs {
  task: Task;
  signal: AbortSignal;
}

export interface TaskOptions {
  id?: any;
  name?: string;
  args?: any[];
  children?: TaskLike[] | (() => TaskLike[] | Promise<TaskLike[]>);
  dependencies?: (Task | string)[];
  concurrency?: number;
  bail?: boolean;
  serial?: boolean;
  exclusive?: boolean;
  abortTimeout?: number;
  onStart?: (task: Task) => void;
  onFinish?: (task: Task) => void;
  onRun?: (task: Task) => void;
  onStatusChange?: (task: Task) => void;
  onUpdate?: (task: Task, properties: string[]) => void;
  onUpdateRecursive?: (task: Task, properties: string[]) => void;
}

export interface TaskUpdateValues {
  status?: TaskStatus;
  message?: string;
  error?: any;
  result?: any;
  waitingFor?: boolean;
}

class TaskContext {
  // allTasks = new Set<Task>();
  executingTasks = new Set<Task>();
  queue = new Set<Task>();
  concurrency!: number;
  triggerPulse!: () => void;
}

const noOp = () => void (0);
const taskContextKey = Symbol.for('power-tasks.Task.context');

let idGen = 0;

export class Task<T = any> extends AsyncEventEmitter {
  protected [taskContextKey]?: TaskContext;
  protected _id = '';
  protected _options: TaskOptions;
  protected _executeFn?: TaskFunction;
  protected _children?: Task[];
  protected _dependencies?: Task[];
  protected _status: TaskStatus = 'idle';
  protected _message?: string;
  protected _executeDuration?: number;
  protected _error?: any;
  protected _result?: T;
  protected _isManaged?: boolean;
  protected _abortController = new AbortController();
  protected _abortTimer?: NodeJS.Timer;
  protected _waitingFor?: Set<Task>;
  protected _failedTasks?: Task[];
  protected _abortedTasks?: Task[];
  protected _childrenLeft?: Set<Task>;

  constructor(children: TaskLike[], options?: Omit<TaskOptions, 'children'>)
  constructor(execute: TaskFunction, options?: TaskOptions)
  constructor(arg0: any, options?: TaskOptions) {
    super();
    this.setMaxListeners(100);
    options = options || {};
    if (Array.isArray(arg0)) {
      options.children = arg0;
    } else this._executeFn = arg0;
    this._options = {...options};
    this._id = this._options.id || '';
    if (this._options.bail == null)
      this._options.bail = true;
    if (options.onStart)
      this.on('start', options.onStart);
    if (options.onFinish)
      this.on('finish', options.onFinish);
    if (options.onRun)
      this.on('run', options.onRun);
    if (options.onStatusChange)
      this.on('status-change', options.onStatusChange);
    if (options.onUpdate)
      this.on('update', options.onUpdate);
    if (options.onUpdateRecursive)
      this.on('update-recursive', options.onUpdateRecursive);
  }

  get id(): string {
    return this._id;
  }

  get name(): string | undefined {
    return this._options.name;
  }

  get children(): Task[] | undefined {
    return this._children;
  }

  get options(): TaskOptions {
    return this._options;
  }

  get message(): string {
    return this._message || '';
  }

  get status(): TaskStatus {
    return this._status;
  }

  get isStarted(): boolean {
    return this.status !== 'idle' && !this.isFinished;
  }

  get isFinished(): boolean {
    return this.status === 'fulfilled' || this.status === 'failed' ||
      this.status === 'aborted';
  }

  get isFailed(): boolean {
    return this.status === 'failed';
  }

  get executeDuration(): number | undefined {
    return this._executeDuration;
  }

  get result(): any {
    return this._result;
  }

  get error(): any {
    return this._error;
  }

  get dependencies(): Task[] | undefined {
    return this._dependencies;
  }

  get needWaiting(): boolean {
    if (this._waitingFor && this._waitingFor.size)
      return true;
    if (this._children) {
      for (const c of this._children) {
        if (c.needWaiting)
          return true;
      }
    }
    return false;
  }

  getWaitingTasks(): Task[] | undefined {
    if (!(this.status === 'waiting' && this._waitingFor && this._waitingFor.size))
      return;
    const out = Array.from(this._waitingFor);
    if (this._children)
      for (const c of this._children) {
        const childTasks = c.getWaitingTasks();
        if (childTasks) {
          childTasks.forEach(t => {
            if (!out.includes(t))
              out.push(t);
          })
        }
      }
    return out;
  }


  abort(): this {
    if (this.isFinished || this.status === 'aborting')
      return this;

    if (!this.isStarted) {
      this._update({status: 'aborted', message: 'aborted'});
      return this;
    }

    const ctx = this[taskContextKey] as TaskContext;
    const timeout = this.options.abortTimeout || 30000;
    this._update({status: 'aborting', message: 'Aborting'});
    if (timeout) {
      this._abortTimer = setTimeout(() => {
        delete this._abortTimer;
        this._update({status: 'aborted', message: 'aborted'});
      }, timeout).unref();
    }
    this._abortChildren()
      .catch(noOp)
      .then(() => {
        if (this.isFinished)
          return;
        if (ctx.executingTasks.has(this)) {
          this._abortController.abort();
          return;
        }
        this._update({status: 'aborted', message: 'aborted'});
      })
    return this;
  }

  start(): this {
    if (this.isStarted)
      return this;
    this._id = this._id || ('t' + (++idGen));
    const ctx = this[taskContextKey] = new TaskContext();
    ctx.concurrency = this.options.concurrency || os.cpus().length;
    let pulseTimer: NodeJS.Timer | undefined;
    ctx.triggerPulse = () => {
      if (pulseTimer || this.isFinished) return;
      pulseTimer = setTimeout(() => {
        pulseTimer = undefined;
        this._pulse();
      }, 1);
    };
    if (this.options.children) {
      this._determineChildrenTree((err) => {
        if (err) {
          this._update({
            status: 'failed',
            error: err,
            message: 'Unable to fetch child tasks. ' + (err.message || err)
          });
          return;
        }
        this._determineChildrenDependencies([]);
        this._start();
      });
    } else this._start();
    return this;
  }

  toPromise(): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.isFinished) {
        if (this.isFailed)
          reject(this.error);
        else resolve(this.result);
        return;
      }
      this.once('finish', () => {
        if (this.isFailed)
          return reject(this.error);
        resolve(this.result);
      });
      if (!this.isStarted && !this._isManaged)
        this.start();
    })
  }

  protected _determineChildrenTree(callback: (err?: any) => void): void {
    const ctx = this[taskContextKey] as TaskContext;
    const options = this._options;
    const handler = (err?: any, value?: any) => {
      if (err)
        return callback(err);
      if (!value)
        return callback();

      if (typeof value === 'function') {
        try {
          const x: any = value();
          handler(undefined, x);
        } catch (err) {
          handler(err);
        }
        return;
      }

      if (Array.isArray(value)) {
        let idx = 1;
        const children = value.reduce<Task[]>((a, v) => {
          // noinspection SuspiciousTypeOfGuard
          if (typeof v === 'function') {
            v = new Task(v, {concurrency: options.concurrency, bail: options.bail});
          }
          if (v instanceof Task) {
            v[taskContextKey] = ctx;
            v._id = v._id || (this._id + '-' + (idx++));
            const listeners = this.listeners('update-recursive');
            listeners.forEach(listener => v.on('update-recursive', listener));
            // ctx.allTasks.add(v);
            a.push(v);
          }
          return a;
        }, [])

        if (children && children.length) {
          this._children = children;
          let i = 0;
          const next = (err?) => {
            if (err)
              return callback(err);
            if (i >= children.length)
              return callback();
            const c = children[i++];
            if (c.options.children)
              c._determineChildrenTree((err) => next(err));
            else
              next();
          }
          next();
        } else
          callback();
        return;
      }
      if (value && typeof value.then === 'function') {
        (value as Promise<TaskLike[]>)
          .then(v => handler(undefined, v))
          .catch(err => handler(err))
        return;
      }

      callback(new Error('Invalid value returned from children() method.'));
    }
    handler(undefined, this._options.children);
  }

  protected _determineChildrenDependencies(scope: Task[]): void {
    if (!this._children)
      return;

    const detectCircular = (t: Task, lookup: Task, path: string = '') => {
      if (!lookup._dependencies)
        return;
      path = path || (t.name || t.id);
      path += ' > ' + (lookup.name || lookup.id);
      if (lookup._dependencies.includes(t))
        throw new Error(`Circular dependency detected. ${path + ' > ' + (t.name || t.id)}`);
      for (const l1 of lookup._dependencies.values())
        detectCircular(t, l1, path);
    }

    const subScope = [...scope, ...Array.from(this._children)];
    for (const c of this._children.values()) {
      c._determineChildrenDependencies(subScope);
      if (!c.options.dependencies)
        continue;

      const dependencies: Task[] = [];
      const waitingFor = new Set<Task>();
      for (const dep of c.options.dependencies) {
        const dependentTask = subScope.find(x =>
          typeof dep === 'string' ? x.name === dep : (x === dep)
        )
        if (!dependentTask)
          throw new Error(`Dependent task (${dep}) of "${c.name}" task could not be found.`);
        if (c === dependentTask)
          throw new Error(`Task "${c.name}" depends on itself.`);
        detectCircular(c, dependentTask);
        if (dependentTask._dependencies?.includes(c))
          throw new Error(`Task "${c.name}" has circular dependency with ${dependentTask.name}.`);
        dependencies.push(dependentTask);
        if (!dependentTask.isFinished)
          waitingFor.add(dependentTask);
      }
      if (dependencies.length)
        c._dependencies = dependencies;
      if (waitingFor.size)
        c._waitingFor = waitingFor;
      c._captureDependencies();
    }
  }

  protected _captureDependencies(): void {
    if (!this._waitingFor)
      return;
    debug(this._id, this.name ? '(' + this.name + ')' : '', this.status, '_captureDependencies');

    const handleDependentAborted = (t: Task) => {
      debug(this._id, this.name ? '(' + this.name + ')' : '', this.status, '_captureDependencies:handleDependentAborted');
      const error: any = new Error('Dependent task' +
        (t.name ? '(' + t.name + ')' : '') + 'has been ' + t.status);
      error.failedTask = t;
      this._update({
        status: t.status,
        message: error.message,
        error
      });
    }

    const waitingFor = this._waitingFor;
    const signal = this._abortController.signal;
    const abortSignalCallback = () => clearWait();
    signal.addEventListener('abort', abortSignalCallback, {once: true});

    const clearWait = () => {
      for (const t of waitingFor) {
        t.removeListener('finish', finishCallback);
      }
      delete this._waitingFor;
    }


    const finishCallback = async (t) => {
      if (this.isStarted && this.status !== 'waiting') {
        clearWait();
        return;
      }
      waitingFor.delete(t);
      if (t.isFailed || t.status === 'aborted') {
        signal.removeEventListener('abort', abortSignalCallback);
        if (this.isStarted)
          this._abortChildren()
            .then(() => {
              handleDependentAborted(t);
            })
            .catch(noOp);
        return;
      }
      if (!waitingFor.size) {
        signal.removeEventListener('abort', abortSignalCallback);
        delete this._waitingFor;
        if (this.isStarted)
          this._startChildren();
      }
    }

    for (const t of waitingFor.values()) {
      if (t.isFailed || t.status === 'aborted') {
        handleDependentAborted(t);
        return;
      }
      t.prependOnceListener('finish', finishCallback);
    }

  }

  protected _start(): void {
    if (this.isStarted || this.isFinished)
      return;
    debug(this._id, this.name ? '(' + this.name + ')' : '', this.status, '_start');

    if (this._waitingFor) {
      this._update({
        status: 'waiting',
        message: 'Waiting for dependencies',
        waitingFor: true
      });
      return;
    }
    this._startChildren();
  }

  protected _startChildren() {
    const children = this._children;
    if (!children) {
      this._pulse();
      return;
    }

    const options = this.options;
    const childrenLeft = this._childrenLeft = new Set(children);
    const failedTasks: Task[] = this._failedTasks = [];
    const abortedTasks: Task[] = this._abortedTasks = [];
    debug(this._id, this.name ? '(' + this.name + ')' : '', this.status,
      '_startChildren:a', children.length);

    const statusChangeCallback = async (t: Task) => {
      if (this.status === 'aborting')
        return;
      if (t.status === 'running')
        this._update({status: 'running', message: 'Running'});
      if (t.status === 'waiting')
        this._update({status: 'waiting', message: 'Waiting'});
    }

    const finishCallback = async (t: Task) => {
      t.removeListener('status-change', statusChangeCallback);
      childrenLeft.delete(t);
      if (t.isFailed || t.status === 'aborted') {
        if (t.isFailed)
          failedTasks.push(t);
        else abortedTasks.push(t);
        if (options.bail && childrenLeft.size) {
          const running = !!children.find(c => c.isStarted);
          if (running)
            this._update({status: 'aborting', message: 'Aborting'});
          this._abortChildren().catch(noOp);
          return;
        }
      }

      if (!childrenLeft.size) {
        delete this._childrenLeft;
        let error: any;
        if (failedTasks.length) {
          error = new Error(failedTasks.length +
            ' child ' + plural('task', failedTasks.length) +
            ' has been failed');
          error.failedTasks = failedTasks;
        }
        if (abortedTasks.length) {
          error = new Error(abortedTasks.length +
            ' child ' + plural('task', abortedTasks.length) +
            ' has been aborted');
          error.abortedTasks = abortedTasks;
        }
        if (error) {
          this._update({
            status: failedTasks.length ? 'failed' : 'aborted',
            error,
            message: error.message
          });
          return;
        }
      }
      this._pulse();
    }

    for (const c of children) {
      c.prependOnceListener('finish', finishCallback);
      c.prependListener('status-change', statusChangeCallback);
    }

    this._pulse();
  }

  protected _pulse() {
    debug(this._id, this.name ? '(' + this.name + ')' : '', this.status, '_pulse:a');

    const ctx = this[taskContextKey] as TaskContext;

    if (this.isFinished ||
      this._waitingFor ||
      this.status === 'aborting' ||
      ctx.executingTasks.has(this)
    ) return;

    const options = this.options;
    if (this._childrenLeft) {
      // Check if we can run multiple child tasks
      for (const c of this._childrenLeft) {
        if ((c.isStarted && options.serial) || (c.status === 'running' && c.options.exclusive)) {
          c._pulse();
          return;
        }
      }

      // start children
      let k = ctx.concurrency - ctx.executingTasks.size;
      for (const c of this._childrenLeft) {
        if (c.isStarted) {
          c._pulse();
          continue;
        }
        if (k-- <= 0)
          return;
        c._start();
        if (options.serial || (c.status === 'running' && c.options.exclusive))
          return;
      }
    }

    if ((this._childrenLeft && this._childrenLeft.size) || ctx.executingTasks.size >= ctx.concurrency)
      return;

    this._update({status: 'running', message: 'Running'});
    debug(this._id, this.name ? '(' + this.name + ')' : '', this.status, '_pulse:c');
    ctx.executingTasks.add(this);
    const t = Date.now();
    const signal = this._abortController.signal;
    (async () => (this._executeFn || noOp)({
      task: this,
      signal
    }))()
      .then((result: any) => {
        debug(this._id, this.name ? '(' + this.name + ')' : '', 'fulfilled', '_pulse:execute:then');
        ctx.executingTasks.delete(this);
        this._executeDuration = Date.now() - t;
        this._update({
          status: 'fulfilled',
          message: 'Task completed',
          result
        });
      })
      .catch(error => {
        ctx.executingTasks.delete(this);
        this._executeDuration = Date.now() - t;
        if (error.code === 'ABORT_ERR') {
          this._update({
            status: 'aborted',
            error,
            message: error instanceof Error ? error.message : '' + error
          });
          return;
        }
        debug(this._id, this.name ? '(' + this.name + ')' : '', 'failed', '_pulse:execute:catch');
        this._update({
          status: 'failed',
          error,
          message: error instanceof Error ? error.message : '' + error
        });
      });
  }

  protected _update(prop: TaskUpdateValues) {
    const oldFinished = this.isFinished;
    const keys: string[] = [];
    const oldStarted = this.isStarted;
    if (prop.status && this._status !== prop.status) {
      this._status = prop.status;
      keys.push('status');
    }
    if (prop.message && this._message !== prop.message) {
      this._message = prop.message;
      keys.push('message');
    }
    if (prop.error && this._error !== prop.error) {
      this._error = prop.error;
      keys.push('error');
    }
    if (prop.result && this._result !== prop.result) {
      this._result = prop.result;
      keys.push('result');
    }
    if (prop.waitingFor) {
      keys.push('waitingFor');
    }
    if (keys.length) {
      if (keys.includes('status')) {
        if (!oldStarted)
          this.emitAsync('start', this).catch(noOp);
        this.emitAsync('status-change', this).catch(noOp);
        if (this._status === 'running')
          this.emitAsync('run', this).catch(noOp);
      }
      this.emitAsync('update', this, keys).catch(noOp);
      this.emitAsync('update-recursive', this, keys).catch(noOp);
      if (this.isFinished && !oldFinished) {
        const ctx = this[taskContextKey];
        if (this._abortTimer) {
          clearTimeout(this._abortTimer);
          delete this._abortTimer;
        }
        delete this[taskContextKey];
        if (this.error)
          this.emitAsync('error', this.error).catch(noOp);
        this.emitAsync('finish', this).catch(noOp);
        if (ctx)
          ctx.triggerPulse();
      }
    }
  }

  protected async _abortChildren(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this._children) {
      for (let i = this._children.length - 1; i >= 0; i--) {
        const child = this._children[i];
        if (!child.isFinished) {
          child.abort();
          promises.push(child.toPromise());
        }
      }
    }
    if (promises.length)
      await Promise.all(promises);
  }

}
