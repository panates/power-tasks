import {AsyncEventEmitter, TypedEventEmitterClass} from 'strict-typed-events';
import {plural} from './utils';

export type TaskFunction = (task: Task) => any | Promise<any>;
export type TaskLike = Task | TaskFunction;
export type CancelFunction = (task: Task) => void | Promise<void>;
export type TaskStatus = 'idle' | 'running' | 'fulfilled' | 'failed' | 'cancelling' | 'cancelled';

export interface TaskOptions {
    name?: any;
    args?: any[];
    children?: TaskLike[] | ((task: Task) => TaskLike[] | Promise<TaskLike[]>);
    cancel?: CancelFunction;
    dependencies?: (Task | string)[];
    concurrency?: number;
    bail?: boolean;
}

export interface TaskEvents {
    start: () => void | Promise<void>;
    finish: (err?: any, result?: any) => void | Promise<void>;
}

const noOp = () => void (0);

export class Task<T = any> extends TypedEventEmitterClass<TaskEvents>(AsyncEventEmitter) {
    protected _options: TaskOptions;
    protected _executeFn: TaskFunction;
    protected _children?: Task[];
    protected _status: TaskStatus = 'idle';
    protected _message?: string;
    protected _startTime?: number;
    protected _finishTime?: number;
    protected _error?: Error;
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

    get isIdle(): boolean {
        return this._status === 'idle';
    }

    get isRunning(): boolean {
        return this._status === 'running';
    }

    get isFailed(): boolean {
        return this._status === 'failed';
    }

    get isCancelling(): boolean {
        return this._status === 'cancelling';
    }

    get isCancelled(): boolean {
        return this._status === 'cancelled';
    }

    get isFinished(): boolean {
        return this._status === 'fulfilled' || this._status === 'failed' ||
            this._status === 'cancelled';
    }

    get startTime(): number | undefined {
        return this._startTime
    }

    get finishTime(): number | undefined {
        return this._finishTime
    }

    get result(): any {
        return this._result;
    }

    get error(): any {
        return this._error;
    }

    execute(): this {
        if (this.isRunning)
            return this;
        this.once('finish', (err, v) => {
            this._result = v;
            this._error = err;
            this._finishTime = Date.now();
        });
        this._execute().catch(noOp);
        return this;
    }

    cancel(): this {
        const promises: Promise<void>[] = [];
        if (!(this.isFinished || this.isCancelling)) {
            const isRunning = this.isRunning;
            this._status = 'cancelling';
            this._message = 'Cancelling';
            if (isRunning) {
                const cancelFn = this.options.cancel;
                if (cancelFn)
                    promises.push((async () => cancelFn(this))().catch(noOp));
            }
        }
        if (this._children)
            promises.push(this._cancelChildren());

        Promise.all(promises)
            .finally(() => this._pulse())
        return this;
    }

    protected async _cancelChildren(): Promise<void> {
        const promises: Promise<void>[] = [];
        if (this._children) {
            this._children.forEach(c => {
                c.cancel();
                if (c.isCancelling)
                    promises.push(c.toPromise(true));
            });
        }
        return Promise.all(promises).then();
    }

    then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
    ): Promise<TResult1 | TResult2> {
        if (this.isIdle)
            this.execute();
        return this.toPromise().then(onfulfilled, onrejected);
    }

    catch<TResult = never>(
        onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null
    ): Promise<T | TResult> {
        if (this.isIdle)
            this.execute();
        return this.toPromise().catch(onrejected);
    }

    finally(onfinally?: (() => void) | undefined | null): Promise<T> {
        if (this.isIdle)
            this.execute();
        return this.toPromise().finally(onfinally);
    }

    async toPromise(suspendErrors?: boolean): Promise<any> {
        if (this.isFinished)
            return this._result;
        if (!(this.isRunning || this.isCancelling))
            return;
        return new Promise((resolve, reject) => {
            this.once('finish', (err: any, result?: any) => {
                if (err && !suspendErrors)
                    reject(err);
                else resolve(result);
            })
        })
    }

    protected async _execute(): Promise<void> {
        this._status = 'running';
        this._startTime = Date.now();
        this._finishTime = undefined;
        this._message = '';
        await this.emitAsync('start').catch(noOp);

        if (typeof this._options.children === 'function') {
            this._children = undefined;
            const children = await this._options.children(this);
            if (Array.isArray(children))
                this._children = wrapChildren(children, this.options);
        }

        this._pulse();
    }

    protected _pulse() {
        if (this.isFinished)
            return;
        const children = this._children;
        let failedCount = 0;
        let childrenLeft = 0;
        let running = 0;
        if (children) {
            for (const c of children) {
                if (c.isRunning)
                    running++;
                if (c.isFailed)
                    failedCount++;
                if (!c.isFinished) {
                    childrenLeft++;
                }
            }

            const options = this.options;
            for (const task of children) {
                if (failedCount && options.bail) {
                    this._status = 'failed';
                    this._message = 'Child task failed.\n' + task._message;
                    const error: any = new Error(task._message);
                    this._cancelChildren()
                        .catch(noOp)
                        .finally(() => this.emitAsync('finish', error));
                    return;
                }
                if (!task.isIdle)
                    continue;
                // Check if tasks have unfinished dependencies
                const dependencies = task.options.dependencies?.map(x =>
                    typeof x === 'string' ? children.find(t => t.name === x) : x
                );
                if (dependencies) {
                    // Check if dependent job failed. If so, we can not continue this job
                    let depTask = dependencies.find((dep) =>
                        children.find(t => t !== task && t === dep));
                    if (depTask) {
                        if (depTask.isFailed) {
                            childrenLeft--;
                            failedCount++;
                            task._status = 'failed';
                            task._message = 'Dependent task failed';
                            const error: any = new Error(task._message);
                            error.dependency = depTask;
                            continue;
                        }
                        if (depTask.isCancelled || depTask.isCancelling) {
                            childrenLeft--;
                            failedCount++;
                            task._status = 'cancelled';
                            task._message = 'Dependent task cancelled';
                            const error: any = new Error(task._message);
                            error.dependency = depTask;
                            continue;
                        }
                        if (!depTask.isFinished) {
                            task._message = 'Waiting dependencies';
                            continue;
                        }
                    }
                }

                running++;
                task.execute();
                task.once('finish', () => this._pulse());

                if (!options.concurrency || running >= options.concurrency)
                    break;
            }
        }

        if (!childrenLeft) {
            if (failedCount) {
                const error: any = new Error(`${failedCount} child ${plural('task', failedCount)} failed`);
                error.failed = failedCount;
                this._status = 'failed';
                this._message = error.message;
                this.emitAsync('finish', error).catch(noOp);
                return;
            }
            if (this.isCancelling) {
                this._status = 'cancelled';
                this._message = 'Cancelled';
                this.emitAsync('finish').catch(noOp);
                return;
            }

            (async () => this._executeFn(this))()
                .then((v: any) => {
                    this._status = 'fulfilled';
                    this._message = 'Task completed';
                    this.emitAsync('finish', undefined, v).catch(noOp);
                })
                .catch(e => {
                    this._status = 'failed';
                    this._message = e instanceof Error ? e.message : '' + e;
                    this.emitAsync('finish', e).catch(noOp);
                })
        }
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
