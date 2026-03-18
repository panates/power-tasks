import DoublyLinked from "doublylinked";
import { AsyncEventEmitter } from "node-events-async";
import { Task, TaskLike } from "./task.js";

/**
 * Options for configuring a {@link TaskQueue}.
 */
export interface TaskQueueOptions {
  /**
   * The maximum number of tasks allowed in the queue (including running tasks).
   */
  maxQueue?: number;
  /**
   * The maximum number of tasks to run concurrently.
   */
  concurrency?: number;
  /**
   * Whether the queue should start in a paused state.
   */
  paused?: boolean;
}

/**
 * A `TaskQueue` manages the execution of tasks with concurrency control.
 * It allows limiting the number of simultaneous tasks and provides methods
 * to pause, resume, and manage the task lifecycle.
 *
 * @extends AsyncEventEmitter
 */
export class TaskQueue extends AsyncEventEmitter {
  /**
   * The maximum number of tasks allowed in the queue.
   */
  maxQueue?: number;
  /**
   * The maximum number of tasks to run concurrently.
   */
  concurrency?: number;
  protected _paused: boolean;
  protected _queue = new DoublyLinked<Task>();
  protected _running = new Set<Task>();

  /**
   * Constructs a new TaskQueue.
   *
   * @param options - Configuration options for the queue.
   */
  constructor(options?: TaskQueueOptions) {
    super();
    this.maxQueue = options?.maxQueue;
    this.concurrency = options?.concurrency;
    this._paused = !!options?.paused;
  }

  /**
   * Gets the total number of tasks in the queue (both queued and running).
   */
  get size() {
    return this._queue.length + this._running.size;
  }

  /**
   * Gets the number of tasks currently running.
   */
  get running() {
    return this._running.size;
  }

  /**
   * Gets the number of tasks currently waiting in the queue.
   */
  get queued() {
    return this._queue.length;
  }

  /**
   * Whether the queue is currently paused.
   */
  get paused(): boolean {
    return this._paused;
  }

  /**
   * Pauses the queue execution. No new tasks will be started.
   */
  pause(): void {
    this._paused = true;
  }

  /**
   * Resumes the queue execution and starts any queued tasks if concurrency allows.
   */
  resume(): void {
    this._paused = false;
    setImmediate(() => this._pulse());
  }

  /**
   * Clears all tasks from the queue and aborts them.
   */
  clearQueue() {
    this._queue.forEach((task) => task.abort());
    this._queue = new DoublyLinked();
  }

  /**
   * Aborts all running tasks and clears the queue.
   */
  abortAll(): void {
    if (!this.size) return;
    this.clearQueue();
    this._running.forEach((task) => task.abort());
  }

  /**
   * Returns a promise that resolves when all tasks have finished and the queue is empty.
   *
   * @returns A promise that resolves when the queue finishes.
   */
  async wait(): Promise<void> {
    if (!this.size) return Promise.resolve();
    return new Promise((resolve) => {
      this.once("finish", resolve);
    });
  }

  /**
   * Adds a task to the beginning of the queue.
   *
   * @template T - The type of the result produced by the task.
   * @param task - The task or task function to enqueue.
   * @returns The {@link Task} instance.
   */
  enqueuePrepend<T = any>(task: TaskLike<T>): Task<T> {
    return this._enqueue(task, true);
  }

  /**
   * Adds a task to the end of the queue.
   *
   * @template T - The type of the result produced by the task.
   * @param task - The task or task function to enqueue.
   * @returns The {@link Task} instance.
   */
  enqueue<T = any>(task: TaskLike<T>): Task<T> {
    return this._enqueue(task, false);
  }

  protected _enqueue<T = any>(task: TaskLike, prepend: boolean): Task<T> {
    if (this.maxQueue && this.size >= this.maxQueue)
      throw new Error(`Queue limit (${this.maxQueue}) exceeded`);
    const taskInstance = task instanceof Task ? task : new Task(task);
    Object.defineProperty(taskInstance, "_isManaged", {
      configurable: false,
      writable: false,
      enumerable: false,
      value: true,
    });
    taskInstance.once("error", (...args: any[]) =>
      this.emitAsync("error", ...args),
    );
    this.emit("enqueue", taskInstance);
    if (prepend) this._queue.unshift(taskInstance);
    else this._queue.push(taskInstance);
    this._pulse();
    return taskInstance;
  }

  protected _pulse() {
    if (this.paused) return;
    while (!this.concurrency || this._running.size < this.concurrency) {
      const task = this._queue.shift();
      if (!task) return;
      this._running.add(task);
      task.prependOnceListener("finish", () => {
        this._running.delete(task);
        if (!(this._running.size || this._queue.length))
          return this.emit("finish");
        this._pulse();
      });
      task.start();
    }
  }
}
