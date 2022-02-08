import {AsyncEventEmitter, TypedEventEmitterClass} from 'strict-typed-events';
import DoublyLinked from 'doublylinked';
import {Task, TaskLike} from './task';

export interface TaskQueueEvents {
    enqueue: (task: TaskLike) => void;
    finish: () => void;
}

export interface TaskQueueOptions {
    maxQueue?: number;
    concurrency?: number;
    paused?: boolean;
}

export class TaskQueue extends TypedEventEmitterClass<TaskQueueEvents>(AsyncEventEmitter) {
    maxQueue?: number;
    concurrency?: number;
    protected _paused: boolean;
    protected _queue = new DoublyLinked<Task>();
    protected _running = new Set<Task>();

    constructor(options?: TaskQueueOptions) {
        super();
        this.maxQueue = options?.maxQueue;
        this.concurrency = options?.concurrency;
        this._paused = !!options?.paused;
    }

    get size() {
        return this._queue.length + this._running.size;
    }

    get running() {
        return this._running.size;
    }

    get queued() {
        return this._queue.length;
    }

    get paused(): boolean {
        return this._paused;
    }

    pause() {
        this._paused = true;
    }

    resume() {
        this._paused = false;
        setImmediate(() => this._pulse());
    }

    clearQueue() {
        this._queue = new DoublyLinked();
    }

    cancelAll() {
        this._running.forEach(task => task.cancel());
    }

    waitFor(): Promise<void> {
        const promises: Promise<void>[] = [];
        this._running.forEach(task => {
            promises.push(task.toPromise());
        });
        return Promise.all(promises).then();
    }

    enqueue(task: TaskLike, immediate?: boolean): Task {
        if (this.maxQueue && this.size >= this.maxQueue)
            throw new Error(`Queue limit (${this.maxQueue}) exceeded`);
        this.emit('enqueue', task);
        const taskInstance = task instanceof Task ? task : new Task(task);
        taskInstance.on('finish', () => this._pulse());
        if (immediate)
            this._queue.unshift(taskInstance);
        else this._queue.push(taskInstance);
        setImmediate(() => this._pulse());
        return taskInstance;
    }

    protected _pulse() {
        if (this.paused)
            return;
        while (true) {
            if (this.concurrency && this._running.size >= this.concurrency)
                return;
            const task = this._queue.shift();
            if (!task)
                return;
            this._running.add(task);
            task.on('finish', () => {
                this._running.delete(task);
                if (!this._running.size)
                    this.emit('finish');
            })
            task.execute();
        }
    }

}
