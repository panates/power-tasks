/**
 * Error thrown when a task is aborted.
 */
export class AbortError extends Error {
  /**
   * Error code.
   * @default "ABORT_ERR"
   */
  code: string = "ABORT_ERR";
}
