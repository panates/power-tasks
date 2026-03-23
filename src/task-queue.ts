import DoublyLinked from "doublylinked";
import { AsyncEventEmitter } from "node-events-async";
import { TaskQueueEvents } from "./interfaces/task-queue-events.js";
import { TaskQueueOptions } from "./interfaces/taskqueue-options.js";
import type { TaskLike } from "./interfaces/types.js";
import { Task } from "./task.js";

/**
 * A `TaskQueue` manages the execution of tasks with concurrency control.
 * It allows limiting the number of simultaneous tasks and provides methods
 * to pause, resume, and manage the task lifecycle.
 *
 * @extends AsyncEventEmitter
 */
export class TaskQueue extends AsyncEventEmitter<TaskQueueEvents> {
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
  protected _runningIds = new Set<string>();

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

  /**
   * Checks if a task with the given ID is currently running.
   *
   * @param id - The ID of the task to check.
   * @returns `true` if a task with the given ID is running, `false` otherwise.
   */
  isRunning(id: string): boolean {
    return this._runningIds.has(id);
  }

  /**
   * Internal method to enqueue a task.
   *
   * @template T - The type of the task result.
   * @param task - The task-like object to enqueue.
   * @param prepend - Whether to add the task to the beginning of the queue.
   * @returns The {@link Task} instance.
   * @protected
   */
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

  /**
   * Internal method to process the queue and start tasks.
   * @protected
   */
  protected _pulse() {
    if (this.paused) return;
    while (!this.concurrency || this._running.size < this.concurrency) {
      const task = this._queue.shift();
      if (!task) return;
      this._running.add(task);
      const id = task.id;
      if (id) this._runningIds.add(id);
      task.prependOnceListener("finish", () => {
        this._running.delete(task);
        if (id) this._runningIds.delete(id);
        if (!(this._running.size || this._queue.length))
          return this.emit("finish");
        this._pulse();
      });
      task.start();
    }
  }
}
