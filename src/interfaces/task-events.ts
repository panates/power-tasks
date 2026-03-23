import type { Task } from "../task.js";
import type { TaskStatus } from "./types.js";

/**
 * Event definitions for the {@link Task} class.
 */
export interface TaskEvents {
  /**
   * Emitted when the task is aborted.
   */
  abort: [task: Task];
  /**
   * Emitted when the task finishes (either successfully, with an error, or aborted).
   */
  finish: [task: Task];
  /**
   * Emitted when the task's execution function begins.
   */
  run: [task: Task];
  /**
   * Emitted when the task encounters an error.
   */
  error: [error: Error, task: Task];
  /**
   * Emitted when one or more properties of the task are updated.
   */
  update: [task: Task, keys: string[]];
  /**
   * Emitted when properties of the task or any of its child tasks are updated.
   */
  "update-recursive": [task: Task, keys: string[]];
  /**
   * Emitted when the task starts.
   */
  start: [task: Task];
  /**
   * Emitted when the task's status changes.
   */
  "status-change": [task: Task, status: TaskStatus];
  /**
   * Emitted when the task stops waiting for dependencies.
   */
  "wait-end": [];
}
