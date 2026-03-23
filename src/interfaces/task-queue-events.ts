import type { Task } from "../task.js";

/**
 * Event definitions for the {@link TaskQueue} class.
 */
export interface TaskQueueEvents {
  /**
   * Emitted when a task in the queue encounters an error.
   */
  error: [error: Error, task: Task | undefined];
  /**
   * Emitted when a task is added to the queue.
   */
  enqueue: [task: Task];
  /**
   * Emitted when all tasks in the queue have finished and the queue is empty.
   */
  finish: [];
}
