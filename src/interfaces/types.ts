import type { Task } from "../task.js";

/**
 * Represents a function that defines the work to be performed by a task.
 *
 * @template T - The type of the result returned by the task.
 * @param args - The arguments provided to the task function, including a task instance and an abort signal.
 * @returns The result of the task, which can be a value or a promise.
 */
export type TaskFunction<T = any> = (args: TaskFunctionArgs) => T | Promise<T>;

/**
 * Arguments passed to a {@link TaskFunction}.
 */
export interface TaskFunctionArgs {
  /**
   * The {@link Task} instance executing the function.
   */
  task: Task;
  /**
   * An `AbortSignal` that can be used to monitor if the task has been aborted.
   */
  signal: AbortSignal;
}

/**
 * Represents a task-like object, which can be either a {@link Task} instance or a {@link TaskFunction}.
 *
 * @template T - The type of the result produced by the task.
 */
export type TaskLike<T = any> = Task<T> | TaskFunction;

/**
 * Represents the possible statuses of a task.
 *
 * - `idle`: The task has been created but not yet started.
 * - `waiting`: The task is waiting for its dependencies to complete.
 * - `running`: The task is currently executing.
 * - `fulfilled`: The task has completed successfully.
 * - `failed`: The task has failed with an error.
 * - `aborting`: The task is in the process of being aborted.
 * - `aborted`: The task has been aborted.
 */
export type TaskStatus =
  | "idle"
  | "waiting"
  | "running"
  | "fulfilled"
  | "failed"
  | "aborting"
  | "aborted";
