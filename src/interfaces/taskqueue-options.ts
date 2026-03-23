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
