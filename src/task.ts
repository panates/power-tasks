import * as os from 'os';
import {AsyncEventEmitter, TypedEventEmitterClass} from 'strict-typed-events';
import _debug from 'debug';
import './types';
import {plural} from './utils';

const debug = _debug('power-tasks:task');

export type TaskFunction = (args: TaskFunctionArgs) => any | Promise<any>;
export type TaskLike = Task | TaskFunction;
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

export interface TaskEvents {
    start: (task: Task) => void;
    finish: (task: Task) => void;
    run: (task: Task) => void;
    'status-change': (task: Task) => void;
    update: (task: Task, properties: string[]) => void;
    'update-recursive': (task: Task, properties: string[]) => void;
}

class TaskContext {
    allTasks = new Set<Task>();
    executingTasks = new Set<Task>();
    queue = new Set<Task>();
    concurrency!: number;
    triggerPulse!: () => void;
}

class TaskData {
    abortController = new AbortController();
    abortTimer?: NodeJS.Timer;
    waitingFor?: Set<Task>;
    failedTasks?: Task[];
    abortedTasks?: Task[];
    childrenLeft?: Set<Task>;
}

const noOp = () => void (0);
const taskContextKey = Symbol.for('power-tasks.Task.context');
const taskDataKey = Symbol.for('power-tasks.Task.data');

let idGen = 0;

export class Task<T = any> extends TypedEventEmitterClass<TaskEvents>(AsyncEventEmitter) {
    protected [taskContextKey]?: TaskContext;
    protected [taskDataKey]?: TaskData;
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
        return !!this[taskDataKey] && !this.isFinished;
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

    get waitingFor(): Task[] | undefined {
        const data = this[taskDataKey];
        return this.status === 'waiting' && data && data.waitingFor && data.waitingFor.size ?
            Array.from(data.waitingFor) : undefined;
    }

    abort(): this {
        if (this.isFinished || this.status === 'aborting')
            return this;

        if (!this.isStarted) {
            this._update({status: 'aborted', message: 'aborted'});
            return this;
        }

        const ctx = this[taskContextKey] as TaskContext;
        const data = this[taskDataKey] as TaskData;
        const timeout = this.options.abortTimeout || 30000;
        this._update({status: 'aborting', message: 'Aborting'});
        if (timeout) {
            data.abortTimer = setTimeout(() => {
                delete data.abortTimer;
                this._update({status: 'aborted', message: 'aborted'});
            }, timeout).unref();
        }
        this._abortChildren()
            .catch(noOp)
            .then(() => {
                if (this.isFinished)
                    return;
                if (ctx.executingTasks.has(this)) {
                    data.abortController.abort();
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
            }, 1).unref();
        };
        if (this.options.children)
            this._wrapChildren((err) => {
                if (err) {
                    this._update({
                        status: 'failed',
                        error: err,
                        message: 'Unable to fetch child tasks. ' + (err.message || err)
                    });
                    return;
                }
                this._start()
            });
        else this._start();
        return this;
    }

    toPromise(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.isFinished)
                resolve(this.status === 'fulfilled' ? this._result : undefined);
            this.once('finish', () => {
                if (this.isFailed)
                    return reject(this.error);
                resolve(this.result);
            });
            if (!this.isStarted)
                this.start();
        })
    }

    protected _wrapChildren(callback: (err?: any) => void): void {
        const ctx = this[taskContextKey] as TaskContext;
        const options = this._options
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
                        ctx.allTasks.add(v);
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
                            c._wrapChildren((err) => next(err));
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

    protected _start(): void {
        debug(this._id, this.name ? '(' + this.name + ')' : '', this.status, '_start');
        this[taskDataKey] = new TaskData();
        this._waitDependencies();
    }

    protected _waitDependencies() {
        const ctx = this[taskContextKey] as TaskContext;
        const data = this[taskDataKey] as TaskData;
        if (this.options.dependencies) {
            debug(this._id, this.name ? '(' + this.name + ')' : '', this.status, '_waitDependencies:a');
            const dependencies: Task[] = [];
            const waitingFor = new Set<Task>();
            for (const dep of this.options.dependencies) {
                for (const t of ctx.allTasks.values()) {
                    if (typeof dep === 'string' ? t.name === dep : (t === dep)) {
                        dependencies.push(t);
                        if (!t.isFinished)
                            waitingFor.add(t);
                    }
                }
            }
            if (dependencies.length)
                this._dependencies = dependencies;

            if (waitingFor.size) {
                debug(this._id, this.name ? '(' + this.name + ')' : '', this.status,
                    '_waitDependencies:b', waitingFor.size);
                data.waitingFor = waitingFor;
                const signal = data.abortController.signal;
                const abortSignalCallback = () => cancelWait();
                signal.addEventListener('abort', abortSignalCallback, {once: true});

                const cancelWait = () => {
                    for (const t of dependencies) {
                        t.removeListener('finish', finishCallback);
                    }
                    delete data.waitingFor;
                }

                const finishCallback = async (t) => {
                    if (this.status !== 'waiting') {
                        cancelWait();
                        return;
                    }
                    waitingFor.delete(t);

                    if (t.isFailed || t.status === 'aborted') {
                        signal.removeEventListener('abort', abortSignalCallback);
                        this._abortChildren()
                            .then(() => {
                                const error: any = new Error('Dependent task' +
                                    (t.name ? '(' + t.name + ')' : '') + 'has been ' + t.status);
                                error.failedTask = t;
                                this._update({
                                    status: t.status,
                                    message: error.message,
                                    error
                                });
                            })
                            .catch(noOp);
                        return;
                    }
                    if (!waitingFor.size) {
                        signal.removeEventListener('abort', abortSignalCallback);
                        delete data.waitingFor;
                        this._startChildren();
                    }
                }

                for (const t of waitingFor) {
                    t.prependOnceListener('finish', finishCallback);
                }
                this._update({
                    status: 'waiting',
                    message: 'Waiting for dependencies',
                    waitingFor: true
                });
                return;
            }
        }
        this._startChildren();
    }

    protected _startChildren() {
        const data = this[taskDataKey] as TaskData;
        const children = this._children;
        if (!children) {
            this._pulse();
            return;
        }

        const options = this.options;
        const childrenLeft = data.childrenLeft = new Set(children);
        const failedTasks: Task[] = data.failedTasks = [];
        const abortedTasks: Task[] = data.abortedTasks = [];
        debug(this._id, this.name ? '(' + this.name + ')' : '', this.status,
            '_startChildren:a', children.length);

        const statusChangeCallback = async (t: Task) => {
            if (t.status === 'running' && this.status === 'idle') {
                this._update({status: 'running', message: 'Running'});
                t.removeListener('status-change', statusChangeCallback);
            }
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
                delete data.childrenLeft;
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
                this._pulse();
            }
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
        const data = this[taskDataKey] as TaskData;

        if (!this.isStarted ||
            this.isFinished ||
            data.waitingFor ||
            this.status === 'aborting' ||
            ctx.executingTasks.has(this)
        ) return;


        const options = this.options;
        // const children = this._children;
        if (data.childrenLeft) {
            // Pulse children recursive
            for (const c of data.childrenLeft) {
                if (c.isStarted && !c.isFinished &&
                    c[taskDataKey]!.childrenLeft?.size) {
                    c._pulse();
                }
            }

            // Check if we can run multiple child tasks
            for (const c of data.childrenLeft) {
                if (c.isStarted) {
                    if (options.serial || c.options.exclusive)
                        return;
                }
            }

            let k = ctx.concurrency - ctx.executingTasks.size;
            // start children
            for (const c of data.childrenLeft) {
                if (!c.isStarted) {
                    if (k-- <= 0)
                        return;
                    if (this.status === 'idle')
                        this._update({status: 'running', message: 'Running'});
                    c._start();
                    if (options.serial || c.options.exclusive)
                        return;
                }
            }
        }

        if ((data.childrenLeft && data.childrenLeft.size) || ctx.executingTasks.size >= ctx.concurrency)
            return;

        this._update({status: 'running', message: 'Running'});
        debug(this._id, this.name ? '(' + this.name + ')' : '', this.status, '_pulse:c');
        ctx.executingTasks.add(this);
        const t = Date.now();
        const signal = data.abortController.signal;
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


    /*
    protected _run(): void {
        const ctx = this[taskContextKey];
        /* istanbul ignore next * /
        if (!ctx) return;

        const children = this._children;
        if (children) {
            const statusChangeCallback = () => {
                if (!(this.status === 'idle' || this.status === 'running' || this.status === 'waiting'))
                    return;
                let running = 0;
                let waiting = 0;
                for (const c of children) {
                    if (c.status === 'waiting')
                        waiting++;
                    else if (c.isFinished)
                        running++;
                }
                if (running)
                    this._update({status: 'running', message: 'Running'});
                else if (waiting) {
                    this._update({status: 'waiting', message: 'Waiting for dependencies'});
                }
            }
            const options = this.options;
            const failedTasks: Task[] = [];
            const abortedTasks: Task[] = [];
            let childrenLeft = children.length;
            const finishCallback = async (t: Task) => {
                t.removeListener('status-change', statusChangeCallback);
                childrenLeft--;
                if (t.isFailed) {
                    failedTasks.push(t);
                    if (options.bail && childrenLeft) {
                        this._abortChildren().catch(noOp);
                        return;
                    }
                } else if (t.status === 'aborted') {
                    abortedTasks.push(t);
                    if (options.bail && childrenLeft) {
                        this._abortChildren().catch(noOp);
                        return;
                    }
                }

                if (!childrenLeft) {
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
                ctx.triggerPulse();
            }

            for (const t of children) {
                // t.prependListener('status-change', statusChangeCallback);
                // t.prependOnceListener('finish', finishCallback);
                t.once('finish', () => ctx.triggerPulse());
            }
        }
        this._pulse();
    }

        protected __pulse() {
            const ctx = this[taskContextKey];
            const data = this[taskDataKey];
            /* istanbul ignore next * /
            if (!(ctx && data)) return;

            if (!this.isStarted ||
                this.status === 'aborting' ||
                ctx.executingTasks.has(this)
            ) return;

            // data.inPulse = true;
            const options = this.options;
            const children = this._children;
            let nextStart: Task | undefined;
            if (children) {
                let childrenLeft = children.length;
                for (const c of children) {
                    if (c.isFinished) {
                        childrenLeft--;
                        continue;
                    }
                    if (c.isStarted) {
                        if (c.status === 'running' && !ctx.executingTasks.has(c))
                            c._pulse();
                        if (options.serial || c.options.exclusive)
                            return;
                        continue;
                    }
                    if (ctx.executingTasks.size < ctx.concurrency)
                        nextStart = nextStart || c;
                }
                if (nextStart)
                    nextStart._start();

                if (childrenLeft)
                    return;
            }

            const t = Date.now();
            ctx.executingTasks.add(this);
            this._update({status: 'running', message: 'Running'});

            const signal = data.abortController.signal;
            (async () => (this._executeFn || noOp)({
                task: this,
                signal,
                children: this.children
            }))()
                .then((result: any) => {
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
                    } else
                        this._update({
                            status: 'failed',
                            error,
                            message: error instanceof Error ? error.message : '' + error
                        });
                });
            ctx.triggerPulse();
        }
    */
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
                this.waitingForSet = undefined;
                delete this[taskContextKey];
                delete this[taskDataKey];
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
