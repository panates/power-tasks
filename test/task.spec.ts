import "./env.js";
import { AbortError, Task } from "../src/index.js";
import { delay } from "../src/utils.js";

const noOp = () => undefined;
const logUpdates = (messages: string[]) => (task: Task) => {
  let s = (task.name || task.id) + ":" + task.status;
  const waitingTasks = task.getWaitingTasks();
  if (waitingTasks) s += ":" + waitingTasks.map((t) => t.name || t.id).join();
  messages.push(s);
};

describe("Task", () => {
  it("should execute sync Task", async () => {
    let i = 0;
    const task = new Task(() => ++i, { id: "t1" });
    const messages: string[] = [];
    const onUpdate = logUpdates(messages);
    task.on("update", onUpdate);
    const r = await task.toPromise();
    expect(messages).toStrictEqual(["t1:running", "t1:fulfilled"]);
    expect(r).toEqual(1);
    expect(i).toEqual(1);
    expect(task.message).toEqual("Task completed");
  });

  it("should execute async Task", async () => {
    let i = 0;
    const task = new Task(
      async () => {
        await delay(50);
        return ++i;
      },
      { id: "t1" },
    );
    const messages: string[] = [];
    const onUpdate = logUpdates(messages);
    task.on("update", onUpdate);
    const r = await task.toPromise();
    expect(messages).toStrictEqual(["t1:running", "t1:fulfilled"]);
    expect(r).toEqual(1);
    expect(i).toEqual(1);
  });

  it("should abort", async () => {
    const task = new Task(
      async ({ signal }) => {
        await delay(20);
        if (signal.aborted) throw new AbortError();
      },
      { id: "t1" },
    );
    const messages: string[] = [];
    const onUpdate = logUpdates(messages);
    task.on("update", onUpdate);
    await task.start();
    await delay(10);
    task.abort();
    await task.toPromise();
    expect(messages).toStrictEqual(["t1:running", "t1:aborting", "t1:aborted"]);
  });

  it('should "abort" do nothing after finish', async () => {
    const task = new Task(() => 0);
    await task.toPromise();
    expect(task.status).toEqual("fulfilled");
    task.abort();
    await task.toPromise();
    expect(task.status).toEqual("fulfilled");
  });

  it("should force abort after timeout", async () => {
    const task = new Task(
      async () => {
        await delay(250);
      },
      {
        abortTimeout: 5,
      },
    );
    await task.start();
    await delay(5);
    const t = Date.now();
    task.abort();
    await task.toPromise();
    expect(Date.now() - t).toBeLessThanOrEqual(50);
  });

  it("should execute child tasks", async () => {
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const task = new Task((args) => args.task.children!.reduce((a, t) => a + t.result, 0), {
      id: "t1",
      children: [
        new Task(() => 1),
        new Task(async () => 2),
        () => 3,
        async () => {
          await delay(50);
          return 4;
        },
      ],
      onUpdateRecursive,
      concurrency: 10,
    });
    const r = await task.toPromise();
    expect(task.status).toEqual("fulfilled");
    expect(r).toEqual(10);
    expect(task.children).toBeDefined();
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-2:running",
      "t1-3:running",
      "t1-4:running",
      "t1-1:fulfilled",
      "t1-3:fulfilled",
      "t1-2:fulfilled",
      "t1-4:fulfilled",
      "t1:fulfilled",
    ]);
  });

  it("should execute child tasks serial", async () => {
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const task = new Task((args) => args.task.children!.reduce((a, t) => a + t.result, 0), {
      id: "t1",
      children: [
        new Task(() => 1),
        new Task(async () => 2),
        () => 3,
        async () => {
          await delay(50);
          return 4;
        },
      ],
      onUpdateRecursive,
      serial: true,
    });
    const r = await task.toPromise();
    expect(task.status).toEqual("fulfilled");
    expect(r).toEqual(10);
    expect(task.children).toBeDefined();
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-1:fulfilled",
      "t1-2:running",
      "t1-2:fulfilled",
      "t1-3:running",
      "t1-3:fulfilled",
      "t1-4:running",
      "t1-4:fulfilled",
      "t1:fulfilled",
    ]);
  });

  it("should limit concurrent tasks", async () => {
    const a: Task[] = [];
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    let running = 0;
    for (let i = 0; i < 8; i++) {
      a.push(
        new Task(async () => {
          running++;
          if (running > 2) throw new Error("Failed");
          await delay(50);
          running--;
        }),
      );
    }
    const task = new Task(a, { id: "t1", concurrency: 2, onUpdateRecursive });
    await task.toPromise();
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-2:running",
      "t1-1:fulfilled",
      "t1-3:running",
      "t1-2:fulfilled",
      "t1-4:running",
      "t1-3:fulfilled",
      "t1-5:running",
      "t1-4:fulfilled",
      "t1-6:running",
      "t1-5:fulfilled",
      "t1-7:running",
      "t1-6:fulfilled",
      "t1-8:running",
      "t1-7:fulfilled",
      "t1-8:fulfilled",
      "t1:fulfilled",
    ]);
  });

  it("should add child tasks on the fly", async () => {
    let i = 0;
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const task = new Task(({ task: task1 }) => task1.children!.length, {
      id: "t1",
      children: async () => [
        new Task(() => {
          i++;
        }),
        new Task(
          async () => {
            i++;
          },
          {
            children: async () => [() => i++],
          },
        ),
      ],
      onUpdateRecursive,
      concurrency: 10,
    });
    await task.toPromise();
    expect(i).toEqual(3);
    expect(task.status).toEqual("fulfilled");
    expect(task.children).toBeDefined();
    expect(task.children!.length).toEqual(2);
    expect(task.children![1].children).toBeDefined();
    expect(task.children![1].children!.length).toEqual(1);
    expect(task.children![0].status).toEqual("fulfilled");
    expect(task.children![1].status).toEqual("fulfilled");
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-2:running",
      "t1-2-1:running",
      "t1-1:fulfilled",
      "t1-2-1:fulfilled",
      "t1-2:fulfilled",
      "t1:fulfilled",
    ]);
  });

  it("should abort child tasks", async () => {
    const aborted: any[] = [];
    const children: any[] = [];
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    for (let i = 0; i < 5; i++) {
      const x = i + 1;
      const c = new Task(
        async ({ signal }) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              aborted.push(x);
              reject(new AbortError());
            });
          }),
      );
      children.push(c);
    }
    children[children.length - 1].once("status-change", (t) => {
      if (t.status === "running") setTimeout(() => task.abort(), 5);
    });

    const task = new Task(() => 0, {
      id: "t1",
      children,
      onUpdateRecursive,
      concurrency: 10,
    });
    task.start();
    await task.toPromise().catch(noOp);
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-2:running",
      "t1-3:running",
      "t1-4:running",
      "t1-5:running",
      "t1:aborting",
      "t1-5:aborting",
      "t1-4:aborting",
      "t1-3:aborting",
      "t1-2:aborting",
      "t1-1:aborting",
      "t1-5:aborted",
      "t1-4:aborted",
      "t1-3:aborted",
      "t1-2:aborted",
      "t1-1:aborted",
      "t1:aborted",
    ]);
    expect(task.status).toEqual("aborted");
    expect(aborted).toEqual([5, 4, 3, 2, 1]);
  });

  it("should abort remaining children then fail, if any child fails (bail=true, serial=true)", async () => {
    let i = 0;
    let c = 0;
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const task = new Task(
      [
        new Task(async () => {
          await delay(10);
          throw new Error("test");
        }),
        new Task(async ({ signal }) => {
          await delay(60);
          if (signal.aborted) c++;
          else i++;
        }),
        new Task(async ({ signal }) => {
          await delay(40);
          if (signal.aborted) c++;
          else i++;
        }),
      ],
      {
        id: "t1",
        bail: true,
        serial: true,
        concurrency: 10,
        onUpdateRecursive,
      },
    );

    await task.toPromise().catch(noOp);
    expect(task.status).toEqual("failed");
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-1:failed",
      "t1-3:aborted",
      "t1-2:aborted",
      "t1:failed",
    ]);
    expect(i).toEqual(0);
    expect(c).toEqual(0);
  });

  it("should abort running children then fail, if any child fails (bail=true, serial=false)", async () => {
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const task = new Task(
      [
        new Task(async () => {
          await delay(50);
          throw new Error("test");
        }),
        new Task(async ({ signal }) => {
          await delay(200);
          if (signal.aborted) throw new AbortError();
        }),
        new Task(async ({ signal }) => {
          await delay(150);
          if (signal.aborted) throw new AbortError();
        }),
      ],
      {
        id: "t1",
        bail: true,
        serial: false,
        concurrency: 10,
        onUpdateRecursive,
      },
    );
    await task.toPromise().catch(noOp);
    expect(task.status).toEqual("failed");
    expect(task.children![0].status).toEqual("failed");
    expect(task.children![1].status).toEqual("aborted");
    expect(task.children![2].status).toEqual("aborted");
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-2:running",
      "t1-3:running",
      "t1-1:failed",
      "t1:aborting",
      "t1-3:aborting",
      "t1-2:aborting",
      "t1-3:aborted",
      "t1-2:aborted",
      "t1:failed",
    ]);
  });

  it("should run all children then fail, if any child fails (bail=false, serial=false)", async () => {
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const task = new Task(
      [
        new Task(async () => {
          await delay(50);
          throw new Error("test");
        }),
        new Task(async ({ signal }) => {
          await delay(200);
          if (signal.aborted) throw new AbortError();
        }),
        new Task(async ({ signal }) => {
          await delay(150);
          if (signal.aborted) throw new AbortError();
        }),
      ],
      {
        id: "t1",
        bail: false,
        serial: false,
        concurrency: 10,
        onUpdateRecursive,
      },
    );

    await task.toPromise().catch(noOp);
    expect(task.status).toEqual("failed");
    expect(task.children![0].status).toEqual("failed");
    expect(task.children![1].status).toEqual("fulfilled");
    expect(task.children![2].status).toEqual("fulfilled");
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-2:running",
      "t1-3:running",
      "t1-1:failed",
      "t1-3:fulfilled",
      "t1-2:fulfilled",
      "t1:failed",
    ]);
  });

  it("should run all children then fail, if any child fails (bail=false, serial=true)", async () => {
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const task = new Task(
      [
        new Task(async () => {
          await delay(50);
          throw new Error("test");
        }),
        new Task(async ({ signal }) => {
          await delay(200);
          if (signal.aborted) throw new AbortError();
        }),
        new Task(async ({ signal }) => {
          await delay(150);
          if (signal.aborted) throw new AbortError();
        }),
      ],
      {
        id: "t1",
        bail: false,
        serial: true,
        concurrency: 10,
        onUpdateRecursive,
      },
    );

    await task.toPromise().catch(noOp);
    expect(task.status).toEqual("failed");
    expect(task.children![0].status).toEqual("failed");
    expect(task.children![1].status).toEqual("fulfilled");
    expect(task.children![2].status).toEqual("fulfilled");
    expect(messages).toStrictEqual([
      "t1:running",
      "t1-1:running",
      "t1-1:failed",
      "t1-2:running",
      "t1-2:fulfilled",
      "t1-3:running",
      "t1-3:fulfilled",
      "t1:failed",
    ]);
  });

  it("should wait for dependent task to complete before execute", async () => {
    const r: number[] = [];
    const newFn = (i: number) => async () => {
      await delay(50 + i * 5);
      r.push(i);
    };
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const c5 = new Task(newFn(5), { name: "c5" });
    const c1 = new Task(newFn(1), { name: "c1", dependencies: [c5] });
    const c4 = new Task(newFn(4), { name: "c4", dependencies: ["c1"] });
    const c2 = new Task(newFn(2), { name: "c2", dependencies: [c4] });
    const c3 = new Task(newFn(3), { name: "c3", dependencies: ["c4"] });
    const task = new Task([c1, c2, c3, c4, c5], { id: "t1", onUpdateRecursive, concurrency: 10 });

    await task.toPromise();
    expect(task.status).toEqual("fulfilled");
    expect(messages).toStrictEqual([
      "t1:waiting",
      "c1:waiting:c5",
      "c2:waiting:c4",
      "c3:waiting:c4",
      "c4:waiting:c1",
      "t1:running",
      "c5:running",
      "c5:fulfilled",
      "c1:running",
      "c1:fulfilled",
      "c4:running",
      "c4:fulfilled",
      "c3:running",
      "c2:running",
      "c2:fulfilled",
      "c3:fulfilled",
      "t1:fulfilled",
    ]);
    expect(r).toEqual([5, 1, 4, 2, 3]);
  });

  it("should fail if dependent task fails", async () => {
    const r: any[] = [];
    const newFn = (i: number, fail?: boolean) => async () => {
      await delay(50 + i * 5);
      if (fail) throw new Error("test");
      r.push(i);
    };
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const c5 = new Task(newFn(5), { name: "c5" });
    const c1 = new Task(newFn(1), { name: "c1", dependencies: [c5] });
    const c4 = new Task(newFn(4, true), { name: "c4", dependencies: ["c1"] });
    const c2 = new Task(newFn(2), { name: "c2", dependencies: [c4] });
    const c3 = new Task(newFn(3), { name: "c3", dependencies: ["c4"] });
    const task = new Task([c1, c2, c3, c4, c5], { id: "t1", onUpdateRecursive, concurrency: 10 });

    await task.toPromise().catch(noOp);
    expect(task.status).toEqual("failed");
    expect(messages).toStrictEqual([
      "t1:waiting",
      "c1:waiting:c5",
      "c2:waiting:c4",
      "c3:waiting:c4",
      "c4:waiting:c1",
      "t1:running",
      "c5:running",
      "c5:fulfilled",
      "c1:running",
      "c1:fulfilled",
      "c4:running",
      "c4:failed",
      "t1:aborting",
      "c3:aborting",
      "c2:aborting",
      "c3:aborted",
      "c2:aborted",
      "t1:failed",
    ]);
    expect(r).toEqual([5, 1]);
  });

  it("should abort if dependent task aborted", async () => {
    const r: any[] = [];
    const newFn = (i: number) => async () => {
      await delay(50 + i * 5);
      r.push(i);
    };
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const c5 = new Task(newFn(5), { name: "c5" });
    const c1 = new Task(newFn(1), { name: "c1", dependencies: [c5] });
    const c4 = new Task(newFn(4), { name: "c4", dependencies: ["c1"] });
    const c2 = new Task(newFn(2), { name: "c2", dependencies: [c4] });
    const c3 = new Task(newFn(3), { name: "c3", dependencies: ["c4"] });
    const task = new Task([c1, c2, c3, c4, c5], { id: "t1", onUpdateRecursive, concurrency: 10 });
    task.start();
    c5.on("finish", () => c4.abort());
    await task.toPromise();
    expect(task.status).toEqual("aborted");
    expect(messages).toStrictEqual([
      "t1:waiting",
      "c1:waiting:c5",
      "c2:waiting:c4",
      "c3:waiting:c4",
      "c4:waiting:c1",
      "t1:running",
      "c5:running",
      "c5:fulfilled",
      "c1:running",
      "c4:aborting",
      "c4:aborted",
      "t1:aborting",
      "c3:aborting",
      "c2:aborting",
      "c1:aborting",
      "c3:aborted",
      "c2:aborted",
      "c1:fulfilled",
      "t1:aborted",
    ]);
    expect(r).toEqual([5, 1]);
  });

  it("should run exclusive tasks one at a time", async () => {
    const r: any[] = [];
    const newFn = (i: number) => async () => {
      await delay(50);
      r.push(i);
    };
    const messages: string[] = [];
    const onUpdateRecursive = logUpdates(messages);
    const c1 = new Task(newFn(1), { name: "c1" });
    const c2 = new Task(newFn(2), { name: "c2", exclusive: true });
    const c3 = new Task(newFn(3), { name: "c3" });
    const c4 = new Task(newFn(4), { name: "c4" });
    const task = new Task([c1, c2, c3, c4], { id: "t1", onUpdateRecursive, concurrency: 10 });

    await task.toPromise();
    expect(task.status).toEqual("fulfilled");
    expect(r).toEqual([1, 2, 3, 4]);
    expect(messages).toStrictEqual([
      "t1:running",
      "c1:running",
      "c1:fulfilled",
      "c2:running",
      "c2:fulfilled",
      "c3:running",
      "c4:running",
      "c3:fulfilled",
      "c4:fulfilled",
      "t1:fulfilled",
    ]);
  });

  it("should detect circular dependencies", async () => {
    const c1 = new Task(noOp, { name: "c1", dependencies: ["c2"] });
    const c2 = new Task(noOp, { name: "c2", dependencies: ["c3"] });
    const c3 = new Task(noOp, { name: "c3", dependencies: ["c1"] });
    const task = new Task([c1, c2, c3], { id: "t1" });

    await expect(() => task.toPromise()).rejects.toThrow("Circular dependency detected");
  });

  it('should emit "error" event on error', (done) => {
    const task = new Task(() => {
      throw new Error("Test error");
    }).on("error", () => done());
    task.toPromise().catch(noOp);
  });
});
