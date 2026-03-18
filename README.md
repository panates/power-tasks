# power-tasks

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![Build Status][ci-image]][ci-url]
[![Test Coverage][coveralls-image]][coveralls-url]
[![Dependencies][dependencies-image]][dependencies-url]
[![DevDependencies][devdependencies-image]][devdependencies-url]

Powerful task management for JavaScript/TypeScript. Support for hierarchical tasks, dependencies, concurrency control, and a task queue.

## Installation

- `npm install power-tasks --save`

## Node Compatibility

- node `>= 14.x`

## Core Concepts

### Task

A `Task` represents a unit of work that can be executed. It can be a simple function, or it can have children and dependencies. Tasks are `AsyncEventEmitter` instances, meaning they emit events during their lifecycle.

#### Creating a Simple Task

```typescript
import { Task } from 'power-tasks';

const task = new Task(async ({ signal }) => {
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
], { name: 'Parent Task' });

await parent.start();
```

#### Task Dependencies

Tasks can depend on other tasks by their name or instance. A task will wait for its dependencies to finish before starting.

```typescript
const task1 = new Task(async () => 'Result 1', { name: 'T1' });
const task2 = new Task(async () => 'Result 2', { 
  name: 'T2', 
  dependencies: ['T1'] 
});

const parent = new Task([task1, task2]);
await parent.start();
```

### TaskQueue

`TaskQueue` manages a list of tasks with concurrency control. It allows you to limit the number of tasks running at the same time and provides methods to pause, resume, and clear the queue.

```typescript
import { TaskQueue } from 'power-tasks';

const queue = new TaskQueue({ concurrency: 2 });

queue.enqueue(async () => { /* ... */ });
queue.enqueue(async () => { /* ... */ });
queue.enqueue(async () => { /* ... */ });

await queue.wait(); // Wait for all tasks to finish
```

## API Reference

### Task Options

| Option | Type | Description |
| --- | --- | --- |
| `id` | `any` | Unique identifier for the task. |
| `name` | `string` | Name of the task (used for dependencies). |
| `args` | `any[]` | Arguments passed to the task function. |
| `children` | `TaskLike[]` \| `() => ...` | List of child tasks or a function that returns them. |
| `dependencies` | `(Task \| string)[]` | Tasks that must finish before this task starts. |
| `concurrency` | `number` | Number of child tasks to run in parallel. |
| `bail` | `boolean` | If true (default), aborts children if one fails. |
| `serial` | `boolean` | If true, runs children one by one (shortcut for concurrency: 1). |
| `exclusive` | `boolean` | If true, the task queue waits for this task to complete exclusively. |
| `abortTimeout` | `number` | Timeout in ms to wait for aborting tasks. |

### Task Statuses

A task can be in one of the following states:
- `idle`: Task is created but not yet started.
- `waiting`: Task is waiting for its dependencies.
- `running`: Task is currently executing.
- `fulfilled`: Task completed successfully.
- `failed`: Task failed with an error.
- `aborting`: Task is in the process of being aborted.
- `aborted`: Task has been aborted.

### Task Events

- `start`: Emitted when the task starts.
- `run`: Emitted when the execution function is called.
- `finish`: Emitted when the task finishes (successfully, failed, or aborted).
- `status-change`: Emitted when the task status changes.
- `update`: Emitted when task properties are updated.
- `error`: Emitted when an error occurs.

### TaskQueue Methods

- `enqueue(task)`: Adds a task to the end of the queue.
- `enqueuePrepend(task)`: Adds a task to the beginning of the queue.
- `pause()`: Pauses the queue execution.
- `resume()`: Resumes the queue execution.
- `clearQueue()`: Removes all queued tasks.
- `abortAll()`: Aborts all running and queued tasks.
- `wait()`: Returns a promise that resolves when the queue is empty and all tasks are finished.

### License

[MIT](LICENSE)

[npm-image]: https://img.shields.io/npm/v/power-tasks.svg
[npm-url]: https://npmjs.org/package/power-tasks
[ci-image]: https://circleci.com/gh/panates/power-tasks/tree/main.svg?style=svg
[ci-url]: https://circleci.com/gh/panates/power-tasks/tree/main
[coveralls-image]: https://img.shields.io/coveralls/panates/power-tasks/master.svg
[coveralls-url]: https://coveralls.io/r/panates/power-tasks
[downloads-image]: https://img.shields.io/npm/dm/power-tasks.svg
[downloads-url]: https://npmjs.org/package/power-tasks
[gitter-image]: https://badges.gitter.im/panates/power-tasks.svg
[gitter-url]: https://gitter.im/panates/power-tasks?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge
[dependencies-image]: https://david-dm.org/panates/power-tasks/status.svg
[dependencies-url]: https://david-dm.org/panates/power-tasks
[devdependencies-image]: https://david-dm.org/panates/power-tasks/dev-status.svg
[devdependencies-url]: https://david-dm.org/panates/power-tasks?type=dev
[quality-image]: http://npm.packagequality.com/shield/power-tasks.png
[quality-url]: http://packagequality.com/#?package=power-tasks
