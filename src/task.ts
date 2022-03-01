import {EventEmitter} from 'events';
import * as os from 'os';
import {AsyncEventEmitter, TypedEventEmitterClass} from 'strict-typed-events';
import {plural} from './utils';

export type TaskFunction = (task: Task) => any | Promise<any>;
export type TaskLike = Task | TaskFunction;
export type CancelFunction = (task: Task) => any | Promise<any>;
export type TaskStatus = 'idle' | 'waiting' | 'running' | 'fulfilled' | 'failed' | 'cancelling' | 'cancelled';

export interface TaskOptions {
    name?: any;
    args?: any[];
    children?: TaskLike[] | ((task: Task) => TaskLike[] | Promise<TaskLike[]>);
    cancel?: CancelFunction;
    dependencies?: (Task | string)[];
    concurrency?: number;
    bail?: boolean;
    serial?: boolean;
    cancelTimeout?: number;
}

export interface TaskUpdateValues {
    status?: TaskStatus;
    message?: string;
    error?: any;
    result?: any;
}

export interface TaskEvents {
    start: (task: Task) => void;
    finish: (task: Task) => void;
    update: (values: TaskUpdateValues, task: Task) => void;
}

class TaskContext extends EventEmitter {
    allTasks = new Set<Task>();
    executingTasks = 0;
    queue = new Set<Task>();
    concurrency!: number;
}

const noOp = () => void (0);

export class Task<T = any> extends TypedEventEmitterClass<TaskEvents>(AsyncEventEmitter) {
    protected _options: TaskOptions;
    protected _executeFn: TaskFunction;
    protected _children?: Task[];
    protected _status: TaskStatus = 'idle';
    protected _message?: string;
    protected _waitingDependencies?: Task[];
    protected _context!: TaskContext;
    protected _executeDuration?: number;
    protected _error?: any;
    protected _result?: T;

    constructor(children: TaskLike[] | ((task: Task) => TaskLike[] | Promise<TaskLike[]>),
                options?: Omit<TaskOptions, 'children'>)
    constructor(execute: TaskFunction, options?: TaskOptions)
    constructor(arg0: any, options?: TaskOptions) {
        super();
        this.setMaxListeners(100);
        options = options || {};
        if (Array.isArray(arg0)) {
            options.children = arg0;
            this._executeFn = noOp;
        } else this._executeFn = arg0;
        this._options = options;
        if (Array.isArray(options.children))
            this._children = wrapChildren(options.children, options);
    }

    get name(): any {
        return this.options.name;
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
        return this.status === 'running' || this.status === 'cancelling' || this.status === 'waiting';
    }

    get isFinished(): boolean {
        return this.status === 'fulfilled' || this.status === 'failed' ||
            this.status === 'cancelled';
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

    get waitingFor(): Task | undefined {
        return this._waitingDependencies?.find(t => !t.isFinished);
    }

    start(): this {
        if (this.isStarted || this._context)
            return this;
        const ctx = this._context = new TaskContext();
        ctx.concurrency = this.options.concurrency || os.cpus().length;
        ctx.allTasks.add(this);
        ctx.setMaxListeners(Number.MAX_SAFE_INTEGER);
        this._fetchChildren()
            .then(() => {
                this._start();
            })
            .catch(error => {
                this._update({
                    status: 'failed',
                    error,
                    message: error instanceof Error ? error.message : '' + error
                });
            });
        return this;
    }

    cancel(): this {
        if (!this.isStarted) {
            this._update({status: 'cancelled', message: 'Cancelled'});
            return this;
        }
        if (this.isFinished || this.status === 'cancelling')
            return this;
        const timeout = this.options.cancelTimeout || 5000;
        const cancelFn = this.options.cancel;
        if (cancelFn || this._children?.length)
            this._update({status: 'cancelling', message: 'Cancelling'});
        let timer: NodeJS.Timer;
        let timedOut = false;
        if (timeout) {
            timer = setTimeout(() => {
                timedOut = true;
                this._update({status: 'cancelled', message: 'Cancelled'});
            }, timeout).unref();
        }
        this._cancelChildren()
            .catch(noOp)
            .then(() => {
                if (!timedOut && cancelFn)
                    return cancelFn(this);
            })
            .finally(() => {
                clearTimeout(timer);
                this._update({status: 'cancelled', message: 'Cancelled'});
            })
        return this;
    }

    async toPromise(): Promise<any> {
        if (this.isFinished)
            return this.status === 'fulfilled' ? this._result : undefined;
        if (!this.isStarted)
            this.start();
        return new Promise((resolve, reject) => {
            this.once('finish', () => {
                if (this.isFailed)
                    return reject(this.error);
                resolve(this.result);
            })
        })
    }

    protected _start(): void {
        if (this.isStarted)
            return;
        if (this.options.dependencies) {
            this._waitingDependencies = [];
            for (const s of this.options.dependencies) {
                for (const t of this._context.allTasks.values()) {
                    if (typeof s === 'string' ? t.name === s : (t === s)) {
                        this._waitingDependencies.push(t);
                    }
                }
            }
        }
        this._pulse();
    }

    protected _pulse() {
        if (this.isFinished || this._status === 'cancelling')
            return;

        if (this._waitingDependencies) {
            for (const t of this._waitingDependencies) {
                if (!t.isFinished) {
                    this._update({
                        status: 'waiting',
                        message: 'Waiting for ' + (t.name ? '"' + t.name + '"' : '') + ' dependencies'
                    });
                    t.once('finish', async () => {
                        if (t.isFailed) {
                            await this._cancelChildren().catch(noOp);
                            const error: any = new Error('Failed due to dependent task' +
                                (t.name ? ' (' + t.name + ')' : ''));
                            error.dependentTask = t;
                            error.dependentError = t.dependentError || t.error;
                            this._update({
                                status: 'failed',
                                error,
                                message: 'Dependent task failed. ' + error.dependentError.message
                            });
                            return;
                        }
                        if (t.status === 'cancelled') {
                            await this._cancelChildren().catch(noOp);
                            this._update({
                                status: 'cancelled',
                                message: 'Canceled due to dependent task' +
                                    (t.name ? ' (' + t.name + ')' : '')
                            });
                            return;
                        }
                        this._pulse();
                    });
                    return;
                }
            }
            this._waitingDependencies = undefined;
        }
        this._update({status: 'running', message: 'Running'});
        const options = this.options;
        let failedChildren = 0;
        let childrenLeft = 0;
        let startedChildren = 0;
        const children = this._children;
        if (children) {
            for (const c of children) {
                if (c.isStarted) {
                    if (options.serial) {
                        c.once('finish', () => this._pulse());
                        return;
                    }
                    startedChildren++;
                }
                if (c.isFailed)
                    failedChildren++;
                if (!c.isFinished)
                    childrenLeft++;
            }

            if (failedChildren) {
                if (options.bail) {
                    // Cancel remaining children
                    this._cancelChildren().finally(() => {
                        const error = new Error(`${failedChildren} child ${plural('task', failedChildren > 1)} failed`);
                        this._update({status: 'failed', error, message: error.message});
                    });
                    return;
                }
                // Wait for running children before fail
                if (startedChildren) {
                    this._context.once('pulse', () => this._pulse());
                    return;
                }
                if (!childrenLeft) {
                    const error = new Error(`${failedChildren} child ${plural('task', failedChildren > 1)} failed`);
                    this._update({status: 'failed', error, message: error.message});
                    return;
                }
            }

            for (const child of children) {
                if (child.isFinished || child.isStarted)
                    continue;
                if (this._context.executingTasks >= this._context.concurrency) {
                    this._context.once('pulse', () => this._pulse());
                    return;
                }
                child._start();
                if (options.serial) {
                    child.once('finish', () => this._pulse());
                    return;
                }
                startedChildren++;
            }

            if (startedChildren) {
                this._context.once('pulse', () => this._pulse());
                return;
            }
        }

        const t = Date.now();
        this._context.executingTasks++;
        (async () => this._executeFn(this))()
            .then((result: any) => {
                this._context.executingTasks--;
                this._executeDuration = Date.now() - t;
                this._update({
                    status: 'fulfilled',
                    message: 'Task completed',
                    result
                });
            })
            .catch(error => {
                this._context.executingTasks--;
                this._executeDuration = Date.now() - t;
                this._update({
                    status: 'failed',
                    error,
                    message: error instanceof Error ? error.message : '' + error
                });
            })
    }

    protected _update(prop: TaskUpdateValues) {
        const oldFinished = this.isFinished;
        const o: TaskUpdateValues = {};
        let i = 0;
        if (prop.status && this._status !== prop.status) {
            this._status = o.status = prop.status;
            i++;
        }
        if (prop.message && this._message !== prop.message) {
            this._message = o.message = prop.message;
            i++;
        }
        if (prop.error && this._error !== prop.error) {
            this._error = o.error = prop.error;
            i++;
        }
        if (prop.result && this._result !== prop.result) {
            this._result = o.result = prop.result;
            i++;
        }
        if (i) {
            if (this.status !== 'waiting')
                this._waitingFor = undefined;
            this.emitAsync('update', o, this).catch(noOp);
            if (this.isFinished && !oldFinished) {
                this.emitAsync('finish', this).catch(noOp);
            }
            this._context.emit('pulse');
        }
    }

    protected async _fetchChildren(): Promise<void> {
        const ctx = this._context;
        const childrenFn = this._options.children;
        if (typeof childrenFn === 'function') {
            const children = await childrenFn(this);
            if (Array.isArray(children))
                this._children = wrapChildren(children, this.options);
        }
        if (this._children) {
            for (const child of this._children) {
                child._context = ctx;
                ctx.allTasks.add(child);
                await child._fetchChildren();
            }
        }
    }

    protected async _cancelChildren(): Promise<void> {
        const promises: Promise<void>[] = [];
        if (this._children) {
            for (let i = this._children.length - 1; i >= 0; i--) {
                const child = this._children[i];
                if (!child.isFinished) {
                    child.cancel();
                    promises.push(child.toPromise());
                }
            }
        }
        await Promise.all(promises);
    }

}

function wrapChildren(arr: any[], options: TaskOptions): Task[] | undefined {
    const children = arr.reduce<Task[]>((a, v) => {
        // noinspection SuspiciousTypeOfGuard
        if (v instanceof Task)
            a.push(v);
        else if (typeof v === 'function') {
            a.push(new Task(v, {concurrency: options.concurrency, bail: options.bail}));
        }
        return a;
    }, [])
    if (children.length > 0)
        return children;
}
