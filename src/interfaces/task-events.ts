import type { Task } from "../task.js";
import type { TaskStatus } from "./types.js";

export interface TaskEvents {
  "wait-end": [];
  start: [Task];
  run: [Task];
  finish: [Task];
  error: [Error, Task];
  abort: [Task];
  update: [Task, string[]];
  "update-recursive": [Task, string[]];
  "status-change": [Task, TaskStatus];
}
