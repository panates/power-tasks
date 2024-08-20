import "./env.js";
import { Task, TaskQueue } from "../src/index.js";
import { delay } from "../src/utils.js";

const noOp = () => undefined;

describe("TaskQueue", () => {
  it("should construct", () => {
    const queue = new TaskQueue();
    expect(queue.maxQueue).toEqual(undefined);
  });

  it("should construct with options", () => {
    const queue = new TaskQueue({
      maxQueue: 100,
      concurrency: 5,
    });
    expect(queue.paused).toEqual(false);
    expect(queue.maxQueue).toEqual(100);
    expect(queue.concurrency).toEqual(5);
  });

  it("should not exceed maxQueue", () => {
    const queue = new TaskQueue({
      maxQueue: 1,
    });
    queue.enqueue(noOp);
    expect(() => queue.enqueue(noOp)).toThrow(/exceeded/);
  });

  it("should execute sync function task", async () => {
    const queue = new TaskQueue({ concurrency: 1 });
    queue.enqueue(async () => await delay(50));
    queue.enqueue(async () => await delay(50));
    await delay(5);
    expect(queue.running).toEqual(1);
    expect(queue.queued).toEqual(1);
    await queue.wait();
    expect(queue.running).toEqual(0);
    expect(queue.queued).toEqual(0);
  });

  it("should execute async function task", (done) => {
    const queue = new TaskQueue();
    queue.enqueue(async () => {
      await delay(5);
      done();
    });
  });

  it("should execute Task instance", (done) => {
    const queue = new TaskQueue();
    queue.enqueue(
      new Task(() => {
        setTimeout(done, 5);
      }),
    );
  });

  it("should task return a TaskInstance", async () => {
    const queue = new TaskQueue();
    const task = queue.enqueue(() => 123);
    expect(task).toBeInstanceOf(Task);
    const r = await task.toPromise();
    expect(r).toStrictEqual(123);
  });

  it('should emit "enqueue" event', (done) => {
    const queue = new TaskQueue();
    queue.on("enqueue", () => {
      done();
    });
    queue.enqueue(() => {});
  });

  it('should emit "finish" event after all task completed', (done) => {
    const queue = new TaskQueue();
    let i = 0;
    queue.on("finish", () => {
      try {
        expect(i).toEqual(2);
      } catch (e) {
        return done(e);
      }
      done();
    });
    queue.enqueue(() => {
      i++;
    });
    queue.enqueue(() => {
      i++;
    });
  });

  it("should enqueue return Task instance", () => {
    const queue = new TaskQueue();
    const p = queue.enqueue(() => {});
    expect(p).toBeInstanceOf(Task);
  });

  it("should add a task to first location in the queue", async () => {
    const queue = new TaskQueue({ concurrency: 1 });
    const q: number[] = [];
    queue.enqueue(async () => {
      q.push(1);
    });
    queue.enqueue(async () => {
      q.push(2);
    });
    queue.enqueuePrepend(async () => {
      q.push(3);
    });
    await queue.wait();
    expect(q).toEqual([1, 3, 2]);
  });

  it("should execute next on error", (done) => {
    const queue = new TaskQueue();
    queue.enqueue(async () => {
      await delay(10);
      throw new Error("test");
    });
    queue.enqueue(async () => {
      await delay(10);
      done();
    });
  });

  it("should pause", (done) => {
    const queue = new TaskQueue();
    queue.pause();
    let i = 0;
    setTimeout(() => {
      i = 1;
      queue.resume();
    }, 250);
    queue.enqueue(() => {
      try {
        expect(i).toEqual(1);
      } catch (e) {
        done(e);
      }
      done();
    });
  });

  it("should clear", async () => {
    const queue = new TaskQueue({ concurrency: 1 });
    let err;
    queue.enqueue(async () => {
      await delay(10);
    });
    queue.enqueue(async () => {
      err = new Error("Failed");
    });
    queue.clearQueue();
    await queue.wait();
    expect(err).not.toBeDefined();
  });

  it("should abort all tasks", async () => {
    const queue = new TaskQueue({ concurrency: 1 });
    queue.enqueue(async () => {
      await delay(10);
    });
    const t2 = queue.enqueue(async () => 0);
    const t3 = queue.enqueue(async () => 0);
    queue.abortAll();
    await queue.wait();
    expect(t2.status).toEqual("aborted");
    expect(t3.status).toEqual("aborted");
    expect(queue.running).toEqual(0);
    expect(queue.queued).toEqual(0);
  });

  it('should emit "error" on error', (done) => {
    const queue = new TaskQueue({ concurrency: 1 });
    queue.on("error", () => done());
    queue.enqueue(async () => {
      throw new Error("Test error");
    });
  });
});
