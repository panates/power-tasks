import { AsyncEventEmitter } from "node-events-async";
import * as os from "os";
import type { TaskEvents } from "./interfaces/task-events.js";
import type { TaskOptions } from "./interfaces/task-options.js";
import type { TaskFunction, TaskLike, TaskStatus } from "./interfaces/types.js";
import { plural } from "./utils.js";

const osCPUs = os.cpus().length;

export interface TaskUpdateValues {
  status?: TaskStatus;
  message?: string;
  error?: any;
  result?: any;
  waitingFor?: boolean;
}

class TaskContext {
  // allTasks = new Set<Task>();
  executingTasks = new Set<Task>();
  queue = new Set<Task>();
  concurrency!: number;
  triggerPulse!: () => void;
}

const noOp = () => undefined;
const taskContextKey = Symbol.for("power-tasks.Task.context");

let idGen = 0;

/**
 * A `Task` represents a unit of work that can be executed.
 * It supports hierarchical tasks, dependencies, and emits events throughout its lifecycle.
 *
 * @template T - The type of the result produced by the task.
 * @extends AsyncEventEmitter
 */
export class Task<T = any> extends AsyncEventEmitter<TaskEvents> {
  protected [taskContextKey]?: TaskContext;
  protected _id = "";
  protected _options: TaskOptions;
  protected _executeFn?: TaskFunction;
  protected _children?: Task[];
  protected _dependencies?: Task[];
  protected _status: TaskStatus = "idle";
  protected _message?: string;
  protected _executeDuration?: number;
  protected _error?: any;
  protected _result?: T;
  protected _isManaged?: boolean;
  protected _abortController = new AbortController();
  protected _abortTimer?: NodeJS.Timeout;
  protected _waitingFor?: Set<Task>;
  protected _failedChildren?: Task[];
  protected _failedDependencies?: Task[];
  protected _childrenLeft?: Set<Task>;

  /**
   * Constructs a new Task with child tasks.
   *
   * @param children - An array of child tasks or task functions.
   * @param options - Configuration options for the task.
   */
  constructor(children: TaskLike[], options?: TaskOptions);
  /**
   * Constructs a new Task with an execution function.
   *
   * @param execute - The function to be executed by the task.
   * @param options - Configuration options for the task.
   */
  constructor(execute: TaskFunction, options?: TaskOptions);
  constructor(arg0: any, options?: TaskOptions) {
    super();
    this.setMaxListeners(100);
    options = options || {};
    if (Array.isArray(arg0)) {
      options.children = arg0;
    } else this._executeFn = arg0;
    this._options = { ...options };
    this._id = this._options.id || "";
    if (this._options.bail == null) this._options.bail = true;
    if (options.onStart) this.on("start", options.onStart);
    if (options.onFinish) this.on("finish", options.onFinish);
    if (options.onRun) this.on("run", options.onRun);
    if (options.onStatusChange)
      this.on("status-change", options.onStatusChange);
    if (options.onUpdate) this.on("update", options.onUpdate);
    if (options.onUpdateRecursive)
      this.on("update-recursive", options.onUpdateRecursive);
    if (options.abortSignal)
      options.abortSignal.addEventListener("abort", () => this.abort());
  }

  /**
   * Gets the unique identifier of the task.
   */
  get id(): string {
    return this._id;
  }

  /**
   * Gets the name of the task.
   */
  get name(): string | undefined {
    return this._options.name;
  }

  /**
   * Gets the list of child tasks.
   */
  get children(): Task[] | undefined {
    return this._children;
  }

  /**
   * Gets the task configuration options.
   */
  get options(): TaskOptions {
    return this._options;
  }

  /**
   * Gets the current message of the task.
   */
  get message(): string {
    return this._message || "";
  }

  /**
   * Gets the current status of the task.
   */
  get status(): TaskStatus {
    return this._status;
  }

  /**
   * Whether the task has started but not yet finished.
   */
  get isStarted(): boolean {
    return this.status !== "idle" && !this.isFinished;
  }

  /**
   * Whether the task has completed (successfully, failed, or aborted).
   */
  get isFinished(): boolean {
    return (
      this.status === "fulfilled" ||
      this.status === "failed" ||
      this.status === "aborted"
    );
  }

  /**
   * Whether the task has failed.
   */
  get isFailed(): boolean {
    return this.status === "failed";
  }

  /**
   * Whether the task has been aborted.
   */
  get isAborted(): boolean {
    return this.status === "aborted" || this.status === "aborting";
  }

  /**
   * Gets the duration of the task execution in milliseconds.
   */
  get executeDuration(): number | undefined {
    return this._executeDuration;
  }

  /**
   * Gets the result produced by the task.
   */
  get result(): any {
    return this._result;
  }

  /**
   * Gets the error if the task failed.
   */
  get error(): any {
    return this._error;
  }

  /**
   * Gets the list of tasks this task depends on.
   */
  get dependencies(): Task[] | undefined {
    return this._dependencies;
  }

  /**
   * Gets the list of child tasks that failed.
   */
  get failedChildren(): Task[] | undefined {
    return this._failedChildren;
  }

  /**
   * Gets the list of dependencies that failed.
   */
  get failedDependencies(): Task[] | undefined {
    return this._failedDependencies;
  }

  /**
   * Whether the task is currently waiting for children or dependencies to finish.
   */
  get needWaiting(): boolean {
    if (this._waitingFor && this._waitingFor.size) return true;
    if (this._children) {
      for (const c of this._children) {
        if (c.needWaiting) return true;
      }
    }
    return false;
  }

  /**
   * Gets a list of tasks that this task is currently waiting for.
   *
   * @returns An array of {@link Task} instances or `undefined`.
   */
  getWaitingTasks(): Task[] | undefined {
    if (
      !(this.status === "waiting" && this._waitingFor && this._waitingFor.size)
    )
      return;
    const out = Array.from(this._waitingFor);
    if (this._children) {
      for (const c of this._children) {
        const childTasks = c.getWaitingTasks();
        if (childTasks) {
          childTasks.forEach((t) => {
            if (!out.includes(t)) out.push(t);
          });
        }
      }
    }
    return out;
  }

  /**
   * Aborts the task execution.
   *
   * @returns The task instance.
   */
  abort(): this {
    if (this.isFinished || this.status === "aborting") return this;

    if (!this.isStarted) {
      this._update({ status: "aborted", message: "aborted" });
      return this;
    }

    const ctx = this[taskContextKey] as TaskContext;
    const timeout = this.options.abortTimeout || 30000;
    this._update({ status: "aborting", message: "Aborting" });
    if (timeout) {
      this._abortTimer = setTimeout(() => {
        delete this._abortTimer;
        this._update({ status: "aborted", message: "aborted" });
      }, timeout).unref();
    }
    this._abortChildren()
      .catch(noOp)
      .then(() => {
        if (this.isFinished) return;
        if (ctx.executingTasks.has(this)) {
          this._abortController.abort();
          return;
        }
        this._update({ status: "aborted", message: "aborted" });
      })
      .catch(noOp);
    return this;
  }

  /**
   * Starts the task execution.
   *
   * @returns The task instance.
   */
  start(): this {
    if (this.isStarted) return this;
    this._id = this._id || "t" + ++idGen;
    const ctx = (this[taskContextKey] = new TaskContext());
    ctx.concurrency = this.options.concurrency || osCPUs;
    let pulseTimer: NodeJS.Timer | undefined;
    ctx.triggerPulse = () => {
      if (pulseTimer || this.isFinished) return;
      pulseTimer = setTimeout(() => {
        pulseTimer = undefined;
        this._pulse();
      }, 1);
    };
    if (this.options.children) {
      this._determineChildrenTree((err) => {
        if (err) {
          this._update({
            status: "failed",
            error: err,
            message: "Unable to fetch child tasks. " + (err.message || err),
          });
          return;
        }
        this._determineChildrenDependencies([]);
        this._start();
      });
    } else this._start();
    return this;
  }

  /**
   * Returns a promise that resolves with the task result or rejects with the task error.
   * If the task has not started and is not managed by a queue, it will be started automatically.
   *
   * @returns A promise that resolves when the task completes.
   */
  toPromise(): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.isFinished) {
        if (this.isFailed) reject(this.error);
        else resolve(this.result);
        return;
      }
      this.once("finish", () => {
        if (this.isFailed) return reject(this.error);
        resolve(this.result);
      });
      if (!this.isStarted && !this._isManaged) this.start();
    });
  }

  protected _determineChildrenTree(callback: (err?: any) => void): void {
    const ctx = this[taskContextKey] as TaskContext;
    const options = this._options;
    const handler = (err?: any, value?: any) => {
      if (err) return callback(err);
      if (!value) return callback();

      if (typeof value === "function") {
        try {
          const x: any = value();
          handler(undefined, x);
        } catch (err2) {
          handler(err2);
        }
        return;
      }

      if (Array.isArray(value)) {
        let idx = 1;
        const children = value.reduce<Task[]>((a, v) => {
          // noinspection SuspiciousTypeOfGuard
          if (typeof v === "function") {
            v = new Task(v, {
              concurrency: options.concurrency,
              bail: options.bail,
            });
          }
          if (v instanceof Task) {
            v[taskContextKey] = ctx;
            v._id = v._id || this._id + "-" + idx++;
            const listeners = this.listeners("update-recursive");
            listeners.forEach((listener) =>
              v.on("update-recursive", listener as any),
            );
            a.push(v);
          }
          return a;
        }, []);

        if (children && children.length) {
          this._children = children;
          let i = 0;
          const next = (err2?: any) => {
            if (err2) return callback(err2);
            if (i >= children.length) return callback();
            const c = children[i++];
            if (c.options.children)
              c._determineChildrenTree((err3) => next(err3));
            else next();
          };
          next();
        } else callback();
        return;
      }
      if (value && typeof value.then === "function") {
        (value as Promise<TaskLike[]>)
          .then((v) => handler(undefined, v))
          .catch((e) => handler(e));
        return;
      }

      callback(new Error("Invalid value returned from children() method."));
    };
    handler(undefined, this._options.children);
  }

  protected _determineChildrenDependencies(scope: Task[]): void {
    if (!this._children) return;

    const detectCircular = (
      t: Task,
      dependencies: Task[],
      path: string = "",
      list?: Set<Task>,
    ) => {
      path = path || t.name || t.id;
      list = list || new Set();
      for (const l1 of dependencies.values()) {
        if (l1 === t) throw new Error(`Circular dependency detected. ${path}`);
        if (list.has(l1)) continue;
        list.add(l1);
        if (l1._dependencies)
          detectCircular(
            t,
            l1._dependencies,
            path + " > " + (l1.name || l1.id),
            list,
          );

        if (l1.children) {
          for (const c of l1.children) {
            if (c === t)
              throw new Error(`Circular dependency detected. ${path}`);
            if (list.has(c)) continue;
            list.add(c);
            if (c._dependencies) detectCircular(t, c._dependencies, path, list);
          }
        }
      }
    };

    const subScope = [...scope, ...Array.from(this._children)];
    for (const c of this._children.values()) {
      c._determineChildrenDependencies(subScope);
      if (!c.options.dependencies) continue;

      const dependencies: Task[] = [];
      const waitingFor = new Set<Task>();
      for (const dep of c.options.dependencies) {
        const dependentTask = subScope.find((x) =>
          typeof dep === "string" ? x.name === dep : x === dep,
        );
        if (!dependentTask || c === dependentTask) continue;
        dependencies.push(dependentTask);
        if (!dependentTask.isFinished) waitingFor.add(dependentTask);
      }
      detectCircular(c, dependencies);
      if (dependencies.length) c._dependencies = dependencies;
      if (waitingFor.size) c._waitingFor = waitingFor;
      c._captureDependencies();
    }
  }

  protected _captureDependencies(): void {
    if (!this._waitingFor) return;
    const failedDependencies: Task[] = [];
    const waitingFor = this._waitingFor;
    const signal = this._abortController.signal;

    const abortSignalCallback = () => clearWait();
    signal.addEventListener("abort", abortSignalCallback, { once: true });

    const handleDependentAborted = () => {
      signal.removeEventListener("abort", abortSignalCallback);
      this._abortChildren()
        .then(() => {
          const isFailed = !!failedDependencies.find(
            (d) => d.status === "failed",
          );
          const error: any = new Error(
            "Aborted due to " +
              (isFailed ? "fail" : "cancellation") +
              " of dependent " +
              plural("task", !!failedDependencies.length),
          );
          error.failedDependencies = failedDependencies;
          this._failedDependencies = failedDependencies;
          this._update({
            status: isFailed ? "failed" : "aborted",
            message: error.message,
            error,
          });
        })
        .catch(noOp);
    };

    const clearWait = () => {
      for (const t of waitingFor) {
        t.removeListener("finish", finishCallback);
      }
      delete this._waitingFor;
    };

    const finishCallback = async (t) => {
      if (this.isStarted && this.status !== "waiting") {
        clearWait();
        return;
      }
      waitingFor.delete(t);
      if (t.isFailed || t.status === "aborted") {
        failedDependencies.push(t);
      }

      // If all dependent tasks completed
      if (!waitingFor.size) {
        delete this._waitingFor;
        signal.removeEventListener("abort", abortSignalCallback);

        // If any of dependent tasks are failed
        if (failedDependencies.length) {
          handleDependentAborted();
          return;
        }
        // If all dependent tasks completed successfully we continue to next step (startChildren)
        if (this.isStarted) this._startChildren();
        else await this.emitAsync("wait-end");
      }
    };

    for (const t of waitingFor.values()) {
      if (t.isFailed || t.status === "aborted") {
        waitingFor.delete(t);
        failedDependencies.push(t);
      } else t.prependOnceListener("finish", finishCallback);
    }
    if (!waitingFor.size) handleDependentAborted();
  }

  protected _start(): void {
    if (this.isStarted || this.isFinished) return;

    if (this._waitingFor) {
      this._update({
        status: "waiting",
        message: "Waiting for dependencies",
        waitingFor: true,
      });
      return;
    }
    this._startChildren();
  }

  protected _startChildren() {
    const children = this._children;
    if (!children) {
      this._pulse();
      return;
    }

    const options = this.options;
    const childrenLeft = (this._childrenLeft = new Set(children));
    const failedChildren: Task[] = [];

    const statusChangeCallback = async (t: Task) => {
      if (this.status === "aborting") return;
      if (t.status === "running")
        this._update({ status: "running", message: "Running" });
      if (t.status === "waiting")
        this._update({ status: "waiting", message: "Waiting" });
    };

    const finishCallback = async (t: Task) => {
      t.removeListener("status-change", statusChangeCallback);
      childrenLeft.delete(t);
      if (t.isFailed || t.status === "aborted") {
        failedChildren.push(t);
        if (options.bail && childrenLeft.size) {
          const running = !!children.find((c) => c.isStarted);
          if (running)
            this._update({ status: "aborting", message: "Aborting" });
          this._abortChildren().catch(noOp);
          return;
        }
      }

      if (!childrenLeft.size) {
        delete this._childrenLeft;
        if (failedChildren.length) {
          const isFailed = !!failedChildren.find((d) => d.status === "failed");
          const error: any = new Error(
            "Aborted due to " +
              (isFailed ? "fail" : "cancellation") +
              " of child " +
              plural("task", !!failedChildren.length),
          );
          error.failedChildren = failedChildren;
          this._failedChildren = failedChildren;
          this._update({
            status: isFailed ? "failed" : "aborted",
            error,
            message: error.message,
          });
          return;
        }
      }
      this._pulse();
    };

    for (const c of children) {
      c.prependOnceListener("wait-end", () => this._pulse());
      c.prependOnceListener("finish", finishCallback);
      c.prependListener("status-change", statusChangeCallback);
    }

    this._pulse();
  }

  protected _pulse() {
    const ctx = this[taskContextKey] as TaskContext;

    if (
      this.isFinished ||
      this._waitingFor ||
      this.status === "aborting" ||
      ctx.executingTasks.has(this)
    )
      return;

    const options = this.options;
    if (this._childrenLeft) {
      // Check if we can run multiple child tasks
      for (const c of this._childrenLeft) {
        if (
          (c.isStarted && options.serial) ||
          (c.status === "running" && c.options.exclusive)
        ) {
          c._pulse();
          return;
        }
      }

      // Check waiting children
      let hasExclusive = false;
      let hasRunning = false;
      for (const c of this._childrenLeft) {
        if (c.isFinished) continue;
        hasExclusive = hasExclusive || !!c.options.exclusive;
        hasRunning = hasRunning || c.status === "running";
      }
      if (hasExclusive && hasRunning) return;

      // start children
      let k = ctx.concurrency - ctx.executingTasks.size;
      for (const c of this._childrenLeft) {
        if (c.isStarted) {
          c._pulse();
          continue;
        }
        if (k-- <= 0) return;
        if (
          c.options.exclusive &&
          (ctx.executingTasks.size || ctx.executingTasks.size)
        )
          return;
        c._start();
        if (options.serial || (c.status === "running" && c.options.exclusive))
          return;
      }
    }

    if (
      (this._childrenLeft && this._childrenLeft.size) ||
      ctx.executingTasks.size >= ctx.concurrency
    )
      return;

    this._update({ status: "running", message: "Running" });
    ctx.executingTasks.add(this);
    const t = Date.now();
    this._execute()
      .then((result: any) => {
        ctx.executingTasks.delete(this);
        this._executeDuration = Date.now() - t;
        this._update({
          status: "fulfilled",
          message: "Task completed",
          result,
        });
      })
      .catch((error) => {
        ctx.executingTasks.delete(this);
        this._executeDuration = Date.now() - t;
        if (error.code === "ABORT_ERR") {
          this._update({
            status: "aborted",
            error,
            message: error instanceof Error ? error.message : "" + error,
          });
          return;
        }
        this._update({
          status: "failed",
          error,
          message: error instanceof Error ? error.message : "" + error,
        });
      });
  }

  protected async _execute() {
    return this._executeFn?.({
      task: this,
      signal: this._abortController.signal,
    });
  }

  protected _update(prop: TaskUpdateValues) {
    const oldFinished = this.isFinished;
    const keys: string[] = [];
    const oldStarted = this.isStarted;
    if (prop.status && this._status !== prop.status) {
      this._status = prop.status;
      keys.push("status");
    }
    if (prop.message && this._message !== prop.message) {
      this._message = prop.message;
      keys.push("message");
    }
    if (prop.error && this._error !== prop.error) {
      this._error = prop.error;
      keys.push("error");
    }
    if (prop.result && this._result !== prop.result) {
      this._result = prop.result;
      keys.push("result");
    }
    if (prop.waitingFor) {
      keys.push("waitingFor");
    }
    if (keys.length) {
      if (keys.includes("status")) {
        if (!oldStarted) this.emitAsync("start", this).catch(noOp);
        this.emitAsync("status-change", this, this.status).catch(noOp);
        if (this._status === "running") this.emitAsync("run", this).catch(noOp);
      }
      this.emitAsync("update", this, keys).catch(noOp);
      this.emitAsync("update-recursive", this, keys).catch(noOp);
      if (this.isFinished && !oldFinished) {
        const ctx = this[taskContextKey];
        if (this._abortTimer) {
          clearTimeout(this._abortTimer);
          delete this._abortTimer;
        }
        delete this[taskContextKey];
        if (this.error) this.emitAsync("error", this.error, this).catch(noOp);
        this.emitAsync("finish", this).catch(noOp);
        if (ctx) ctx.triggerPulse();
      }
    }
  }

  protected async _abortChildren(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this._children) {
      for (let i = this._children.length - 1; i >= 0; i--) {
        const child = this._children[i];
        if (!child.isFinished) {
          child.abort();
          promises.push(child.toPromise());
        }
      }
    }
    if (promises.length) await Promise.all(promises);
  }
}
