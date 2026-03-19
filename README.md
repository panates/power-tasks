# power-tasks

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]

Powerful task management for JavaScript/TypeScript. Support for hierarchical tasks, dependencies, concurrency control,
and a task queue.

## Installation

- `npm install power-tasks --save`

## Node Compatibility

- node `>= 14.x`

## Core Concepts

### Task

A `Task` represents a unit of work that can be executed. It can be a simple function, or it can have children and
dependencies. Tasks are `AsyncEventEmitter` instances, meaning they emit events during their lifecycle.

#### Creating a Simple Task

```typescript
import { Task } from 'power-tasks';

const task = new Task(async ({signal}) => {
  // Do some work
  return 'Result';
});

task.on('start', () => console.log('Task started!'));
task.on('finish', (t) => console.log(`Task finished with result: ${t.result}`));

await task.start();
```

#### Hierarchical Tasks

Tasks can have children. A parent task is considered finished when all its children are finished.

```typescript
const parent = new Task([
  new Task(async () => 'Child 1'),
  new Task(async () => 'Child 2')
], {name: 'Parent Task'});

await parent.start();
```

#### Task Dependencies

Tasks can depend on other tasks by their name or instance. A task will wait for its dependencies to finish before
starting.

```typescript
const task1 = new Task(async () => 'Result 1', {name: 'T1'});
const task2 = new Task(async () => 'Result 2', {
  name: 'T2',
  dependencies: ['T1']
});

const parent = new Task([task1, task2]);
await parent.start();
```

### TaskQueue

`TaskQueue` manages a list of tasks with concurrency control. It allows you to limit the number of tasks running at the
same time and provides methods to pause, resume, and clear the queue.

```typescript
import { TaskQueue } from 'power-tasks';

const queue = new TaskQueue({concurrency: 2});

queue.enqueue(async () => { /* ... */
});
queue.enqueue(async () => { /* ... */
});
queue.enqueue(async () => { /* ... */
});

await queue.wait(); // Wait for all tasks to finish
```

## API Reference

### Task

A `Task` represents a unit of work that can be executed. It supports hierarchical tasks, dependencies, and emits events
throughout its lifecycle.

#### Constructor

- `new Task(execute, options?)`
    - `execute`: `TaskFunction` - The function to be executed by the task.
    - `options`: `[TaskOptions](#taskoptions) - Configuration options for the task.
- `new Task(children, options?)`
    - `children`: `TaskLike[]` - An array of child tasks or task functions.
    - `options`: [TaskOptions](#taskoptions) - Configuration options for the task.

#### Properties

| Property             | Type                        | Description                                                                   |
|----------------------|-----------------------------|-------------------------------------------------------------------------------|
| `id`                 | `string`                    | Unique identifier of the task.                                                |
| `name`               | `string` \| `undefined`     | Name of the task.                                                             |
| `status`             | [TaskStatus](#taskstatus)   | Current status of the task.                                                   |
| `message`            | `string`                    | Current message of the task.                                                  |
| `result`             | `any`                       | Result produced by the task.                                                  |
| `error`              | `any`                       | Error if the task failed.                                                     |
| `isStarted`          | `boolean`                   | Whether the task has started but not yet finished.                            |
| `isFinished`         | `boolean`                   | Whether the task has completed (successfully, failed, or aborted).            |
| `isFailed`           | `boolean`                   | Whether the task has failed.                                                  |
| `executeDuration`    | `number` \| `undefined`     | Duration of the task execution in milliseconds.                               |
| `children`           | `Task[]` \| `undefined`     | List of child tasks.                                                          |
| `dependencies`       | `Task[]` \| `undefined`     | List of tasks this task depends on.                                           |
| `failedChildren`     | `Task[]` \| `undefined`     | List of child tasks that failed.                                              |
| `failedDependencies` | `Task[]` \| `undefined`     | List of dependencies that failed.                                             |
| `needWaiting`        | `boolean`                   | Whether the task is currently waiting for children or dependencies to finish. |
| `options`            | [TaskOptions](#taskoptions) | Task configuration options.                                                   |

#### Methods

- `start()`: Starts the task execution. Returns the task instance.
  ```typescript
  task.start();
  ```
- `abort()`: Aborts the task execution. Returns the task instance.
  ```typescript
  task.abort();
  ```
- `toPromise()`: Returns a promise that resolves with the task result or rejects with the task error.
  ```typescript
  const result = await task.toPromise();
  ```
- `getWaitingTasks()`: Gets a list of tasks that this task is currently waiting for.
  ```typescript
  const waitingTasks = task.getWaitingTasks();
  ```

#### Events

- `start`: Emitted when the task starts.
  ```typescript
  task.on('start', (task) => console.log('Started'));
  ```
- `run`: Emitted when the execution function is called.
  ```typescript
  task.on('run', (task) => console.log('Running'));
  ```
- `finish`: Emitted when the task finishes (successfully, failed, or aborted).
  ```typescript
  task.on('finish', (task) => console.log('Finished'));
  ```
- `status-change`: Emitted when the task status changes.
  ```typescript
  task.on('status-change', (task) => console.log('Status changed to', task.status));
  ```
- `update`: Emitted when task properties are updated.
  ```typescript
  task.on('update', (task, properties) => console.log('Updated', properties));
  ```
- `error`: Emitted when an error occurs.
  ```typescript
  task.on('error', (error) => console.error(error));
  ```

### TaskOptions

| Option         | Type                        | Description                                                                                     |
|----------------|-----------------------------|-------------------------------------------------------------------------------------------------|
| `id`           | `any`                       | Unique identifier for the task.                                                                 |
| `name`         | `string`                    | Name of the task (used for dependencies).                                                       |
| `args`         | `any[]`                     | Arguments passed to the task function.                                                          |
| `children`     | `TaskLike[]` \| `() => ...` | List of child tasks or a function that returns them.                                            |
| `dependencies` | `(Task \| string)[]`        | Tasks that must finish before this task starts.                                                 |
| `concurrency`  | `number`                    | Number of child tasks to run in parallel.                                                       |
| `bail`         | `boolean`                   | If true (default), aborts children if one fails.                                                |
| `serial`       | `boolean`                   | If true, runs children one by one (shortcut for concurrency: 1).                                |
| `exclusive`    | `boolean`                   | If true, the task queue waits for this task to complete exclusively.                            |
| `abortSignal`  | `AbortSignal`               | An optional AbortSignal object that can be used to communicate with, or to abort, an operation. |
| `abortTimeout` | `number`                    | Timeout in ms to wait for aborting tasks.                                                       |

### TaskStatus

A task can be in one of the following states:

- `idle`: Task is created but not yet started.
- `waiting`: Task is waiting for its dependencies.
- `running`: Task is currently executing.
- `fulfilled`: Task completed successfully.
- `failed`: Task failed with an error.
- `aborting`: Task is in the process of being aborted.
- `aborted`: Task has been aborted.

### TaskQueue

`TaskQueue` manages the execution of tasks with concurrency control.

#### Constructor

- `new TaskQueue(options?)`
    - `options`: `TaskQueueOptions` - Configuration options for the queue.

#### Properties

| Property      | Type                    | Description                                                   |
|---------------|-------------------------|---------------------------------------------------------------|
| `size`        | `number`                | Total number of tasks in the queue (both queued and running). |
| `running`     | `number`                | Number of tasks currently running.                            |
| `queued`      | `number`                | Number of tasks currently waiting in the queue.               |
| `paused`      | `boolean`               | Whether the queue is currently paused.                        |
| `concurrency` | `number` \| `undefined` | The maximum number of tasks to run concurrently.              |
| `maxQueue`    | `number` \| `undefined` | The maximum number of tasks allowed in the queue.             |

#### Methods

- `enqueue(task)`: Adds a task to the end of the queue. Returns the `Task` instance.
  ```typescript
  const task = queue.enqueue(async () => 'Done');
  ```
- `enqueuePrepend(task)`: Adds a task to the beginning of the queue. Returns the `Task` instance.
  ```typescript
  queue.enqueuePrepend(myTask);
  ```
- `pause()`: Pauses the queue execution.
  ```typescript
  queue.pause();
  ```
- `resume()`: Resumes the queue execution.
  ```typescript
  queue.resume();
  ```
- `clearQueue()`: Removes all queued tasks and aborts them.
  ```typescript
  queue.clearQueue();
  ```
- `abortAll()`: Aborts all running tasks and clears the queue.
  ```typescript
  queue.abortAll();
  ```
- `wait()`: Returns a promise that resolves when all tasks have finished and the queue is empty.
  ```typescript
  await queue.wait();
  ```

#### Events

- `enqueue`: Emitted when a task is added to the queue.
  ```typescript
  queue.on('enqueue', (task) => console.log('Task enqueued'));
  ```
- `finish`: Emitted when all tasks in the queue have finished and the queue is empty.
  ```typescript
  queue.on('finish', () => console.log('Queue finished'));
  ```
- `error`: Emitted when a task in the queue emits an error.
  ```typescript
  queue.on('error', (error) => console.error(error));
  ```

### License

[MIT](LICENSE)

[npm-image]: https://img.shields.io/npm/v/power-tasks.svg

[npm-url]: https://npmjs.org/package/power-tasks

[ci-test-image]: https://github.com/panates/power-tasks/actions/workflows/test.yml/badge.svg

[ci-test-url]: https://github.com/panates/power-tasks/actions/workflows/test.yml

[coveralls-image]: https://img.shields.io/coveralls/panates/power-tasks/master.svg

[coveralls-url]: https://coveralls.io/r/panates/power-tasks

[downloads-image]: https://img.shields.io/npm/dm/power-tasks.svg

[downloads-url]: https://npmjs.org/package/power-tasks

[gitter-image]: https://badges.gitter.im/panates/power-tasks.svg

[gitter-url]: https://gitter.im/panates/power-tasks?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge

[dependencies-image]: https://david-dm.org/panates/power-tasks/status.svg

[dependencies-url]:https://david-dm.org/panates/power-tasks

[devdependencies-image]: https://david-dm.org/panates/power-tasks/dev-status.svg

[devdependencies-url]:https://david-dm.org/panates/power-tasks?type=dev

[quality-image]: http://npm.packagequality.com/shield/power-tasks.png

[quality-url]: http://packagequality.com/#?package=power-tasks
