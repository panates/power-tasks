import type { Task } from "../task.js";
import type { TaskLike } from "./types.js";

/**
 * Options for configuring a {@link Task}.
 */
export interface TaskOptions {
  /**
   * Unique identifier for the task.
   */
  id?: any;

  /**
   * Name of the task. This value is used for dependency management.
   */
  name?: string;

  /**
   * Title of the task
   */
  title?: string;

  /**
   * Description of the task
   */
  description?: string;

  /**
   * Arguments to be passed to the task function.
   */
  args?: any[];

  /**
   * A list of child tasks or a function that returns them.
   */
  children?: TaskLike[] | (() => TaskLike[] | Promise<TaskLike[]>);

  /**
   * A list of tasks (instances or names) that must complete before this task starts.
   */
  dependencies?: (Task | string)[];

  /**
   * The maximum number of child tasks to run in parallel.
   * Defaults to the number of OS CPUs.
   */
  concurrency?: number;

  /**
   * Whether to abort remaining child tasks if one fails.
   * @default true
   */
  bail?: boolean;

  /**
   * Whether to run child tasks sequentially (one by one).
   * Equivalent to setting `concurrency: 1`.
   */
  serial?: boolean;

  /**
   * Whether the task should run exclusively.
   * If true, a task queue will wait for this task to complete before starting other tasks,
   * even if concurrency is greater than 1.
   */
  exclusive?: boolean;

  /**
   * An optional AbortSignal object that can be used to communicate with, or to abort, an operation.
   * The abortSignal allows you to signal cancellation requests or abort ongoing tasks.
   * Typically used for managing the lifecycle of async operations.
   */
  abortSignal?: AbortSignal;

  /**
   * Timeout in milliseconds to wait for the task to abort before forcing an 'aborted' status.
   * @default 30000
   */
  abortTimeout?: number;

  /**
   * Callback invoked when the task starts.
   */
  onStart?: (task: Task) => void;
  /**
   * Callback invoked when the task finishes (successfully, failed, or aborted).
   */
  onFinish?: (task: Task) => void;
  /**
   * Callback invoked when the task's execution function begins.
   */
  onRun?: (task: Task) => void;
  /**
   * Callback invoked when the task's status changes.
   */
  onStatusChange?: (task: Task) => void;
  /**
   * Callback invoked when the task's properties are updated.
   */
  onUpdate?: (task: Task, properties: string[]) => void;
  /**
   * Callback invoked when the task or any of its children's properties are updated.
   */
  onUpdateRecursive?: (task: Task, properties: string[]) => void;
}
