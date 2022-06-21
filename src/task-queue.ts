import {AsyncEventEmitter} from 'strict-typed-events';
import DoublyLinked from 'doublylinked';
import {Task, TaskLike} from './task.js';

export interface TaskQueueOptions {
  maxQueue?: number;
  concurrency?: number;
  paused?: boolean;
}

export class TaskQueue extends AsyncEventEmitter {
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

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
    setImmediate(() => this._pulse());
  }

  clearQueue() {
    this._queue.forEach(task => task.abort());
    this._queue = new DoublyLinked();
  }

  abortAll(): void {
    if (!this.size)
      return;
    this.clearQueue();
    this._running.forEach(task => task.abort());
  }

  async wait(): Promise<void> {
    if (!this.size)
      return Promise.resolve();
    return new Promise(resolve => {
      this.once('finish', resolve);
    });
  }

  enqueuePrepend(task: TaskLike): Task {
    return this._enqueue(task, true);
  }

  enqueue(task: TaskLike): Task {
    return this._enqueue(task, false);
  }

  protected _enqueue(task: TaskLike, prepend: boolean): Task {
    if (this.maxQueue && this.size >= this.maxQueue)
      throw new Error(`Queue limit (${this.maxQueue}) exceeded`);
    const taskInstance = task instanceof Task ? task : new Task(task);
    this.emit('enqueue', taskInstance);
    if (prepend)
      this._queue.unshift(taskInstance);
    else this._queue.push(taskInstance);
    this._pulse();
    return taskInstance;
  }

  protected _pulse() {
    if (this.paused)
      return;
    while (!this.concurrency || this._running.size < this.concurrency) {
      const task = this._queue.shift();
      if (!task)
        return;
      this._running.add(task);
      task.prependOnceListener('finish', () => {
        this._running.delete(task);
        if (!(this._running.size || this._queue.length))
          return this.emit('finish');
        this._pulse();
      })
      task.start();
    }
  }

}
