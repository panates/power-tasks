import assert from 'assert';
import './env';
import {Task} from '../src';
import {delay} from '../src/utils';

const noOp = () => void (0);

describe('Task', function () {

    it('should execute simple function', async function () {
        const t = Date.now();
        let i = 0;
        const task = new Task(() => ++i);
        const r = await task.execute().toPromise();
        assert.strictEqual(task.status, 'fulfilled');
        assert.strictEqual(r, 1);
        assert.strictEqual(i, 1);
        assert.ok(task.startTime >= t);
        assert.ok(task.finishTime <= Date.now());
    });

    it('should execute async function', async function () {
        const t = Date.now();
        let i = 0;
        const task = new Task(async () => {
            await delay(50);
            return ++i;
        });
        task.execute();
        assert.strictEqual(task.status, 'running');
        const r = await task.toPromise();
        assert.strictEqual(task.status, 'fulfilled');
        assert.strictEqual(r, 1);
        assert.strictEqual(i, 1);
        assert.ok(task.startTime >= t);
        assert.ok(task.finishTime <= Date.now());
    });

    it('should use promise like', async function () {
        const t = Date.now();
        let i = 0;
        const task = new Task(async () => {
            await delay(50);
            return ++i;
        });
        task.execute();
        assert.strictEqual(task.status, 'running');
        const r = await task;
        assert.strictEqual(task.status, 'fulfilled');
        assert.strictEqual(r, 1);
        assert.strictEqual(i, 1);
        assert.ok(task.startTime >= t);
        assert.ok(task.finishTime <= Date.now());
    });

    it('should execute child tasks', async function () {
        const task = new Task((task1 => {
            return task1.children.reduce((a, t) => a + t.result, 0);
        }), {
            children: [
                new Task(() => {
                    return 1;
                }),
                new Task(async () => 2),
                () => 3,
                async () => {
                    await delay(50);
                    return 4;
                }
            ]
        });
        task.execute();
        assert.strictEqual(task.status, 'running');
        const r = await task.toPromise();
        assert.strictEqual(task.status, 'fulfilled');
        assert.strictEqual(r, 10);
        assert.ok(task.children);
    });

    it('should cancel child tasks', async function () {
        let cancelled = [];
        let fulfilled = [];
        const children = [];
        for (let i = 0; i < 5; i++) {
            const x = i + 1;
            children.push(new Task(
                async (task) => {
                    await delay(50);
                    if (task.isRunning)
                        fulfilled.push(x);
                }, {
                    cancel: async () => {
                        await delay(5);
                        cancelled.push(x);
                    }
                }
            ))
        }
        const task = new Task(() => 0, {children, bail: true, concurrency: 10});
        task.execute();
        assert.strictEqual(task.status, 'running');
        await delay(10);
        task.cancel();
        await task.toPromise();
        assert.strictEqual(task.isCancelled, true);
        assert.strictEqual(task.status, 'cancelled');
        for (const t of task.children) {
            assert.strictEqual(t.status, 'cancelled');
        }
        assert.deepStrictEqual(fulfilled, []);
        assert.deepStrictEqual(cancelled, [1, 2, 3, 4, 5]);
    });

    it('should return child tasks within children function in options', async function () {
        let i = 0;
        const task = new Task((task1) => task1.children.length, {
            children: async () => {
                return [
                    new Task(() => {
                        i++;
                    }),
                    new Task(async () => {
                        i++;
                    })
                ]
            }
        });
        await task;
        assert.strictEqual(i, 2);
        assert.strictEqual(task.status, 'fulfilled');
        assert.ok(task.children);
        assert.strictEqual(task.children.length, 2);
        assert.strictEqual(task.children[0].status, 'fulfilled');
        assert.strictEqual(task.children[1].status, 'fulfilled');
    });

    it('should fail if one child fails, but execute all children', async function () {
        let i = 0;
        const task = new Task([
            new Task(() => {
                throw new Error('test');
            }, {name: 'task1'}),
            new Task(async () => {
                i++;
            }, {name: 'task2'})
        ]);
        await task.catch(noOp);
        assert.strictEqual(task.status, 'failed');
        assert.strictEqual(i, 1);
        assert.ok(task.children);
        assert.strictEqual(task.children.length, 2);
        assert.strictEqual(task.children[0].status, 'failed');
        assert.strictEqual(task.children[0].name, 'task1');
        assert.strictEqual(task.children[1].status, 'fulfilled');
        assert.strictEqual(task.children[1].name, 'task2');
    });

    it('should cancel other children, if one child fails (bail=true)', async function () {
        let i = 0;
        const task = new Task([
            new Task(() => {
                throw new Error('test');
            }),
            new Task(async () => {
                i++;
            })
        ], {bail: true});
        await task.catch(noOp);
        assert.strictEqual(i, 0);
        assert.strictEqual(task.status, 'failed');
        assert.ok(task.children);
        assert.strictEqual(task.children.length, 2);
        assert.strictEqual(task.children[0].status, 'failed');
        assert.strictEqual(task.children[1].status, 'cancelled');
    });

    it('should execute child tasks concurrent', async function () {
        const arr = [];
        const task = new Task([
            new Task(async () => {
                await delay(10);
                arr.push(1);
            }),
            new Task(async () => {
                await delay(5);
                arr.push(2);
            })
        ], {concurrency: 10});
        await task.execute().toPromise();
        assert.strictEqual(arr.length, 2);
        assert.strictEqual(task.status, 'fulfilled');
        assert.ok(task.children);
        assert.strictEqual(task.children.length, 2);
        assert.strictEqual(arr[0], 2);
        assert.strictEqual(arr[1], 1);
    });

    it('should limit concurrent tasks', async function () {
        const a = [];
        for (let i = 0; i < 8; i++) {
            a.push(async () => {
                await delay(50);
            })
        }
        const task = new Task(a, {concurrency: 2});
        await task.execute().toPromise();
        for (let i = 0; i < task.children.length; i += 4) {
            assert.ok(task.children[i + 1].startTime - task.children[i].startTime < 5);
            assert.ok(task.children[i + 2].startTime - task.children[i + 1].startTime >= 50);
            assert.ok(task.children[i + 3].startTime - task.children[i + 2].startTime < 5);
        }
    });

    it('should call "cancel" function if task is running and other child fails', async function () {
        let i = 0;
        let cancelled = false;
        let fulfilled = false;
        const task = new Task([
            new Task(
                async () => {
                    await delay(20);
                    if (!cancelled)
                        fulfilled = true;
                }, {
                    cancel: async () => {
                        await delay(10);
                        cancelled = true;
                    }
                }
            ),
            async () => {
                throw new Error('test')
            }
        ], {bail: true, concurrency: 10});
        await task.execute().toPromise(true);
        assert.strictEqual(i, 0);
        assert.strictEqual(task.status, 'failed');
        assert.ok(task.children);
        assert.strictEqual(cancelled, true);
        assert.strictEqual(fulfilled, false);
        assert.strictEqual(task.children.length, 2);
        assert.strictEqual(task.children[0].status, 'cancelled');
        assert.strictEqual(task.children[1].status, 'failed');
    });

    it('should wait for dependent task to complete before execute', async function () {
        const r = [];
        const newFn = (i: number) => (
            async () => {
                await delay(50 + (i * 5));
                r.push(i);
            });
        const t5 = new Task(newFn(5), {name: 't5'});
        const t1 = new Task(newFn(1), {name: 't1', dependencies: [t5]});
        const t4 = new Task(newFn(4), {name: 't4', dependencies: ['t1']});
        const t2 = new Task(newFn(2), {name: 't2', dependencies: [t4]});
        const t3 = new Task(newFn(3), {name: 't3', dependencies: ['t4']});
        const task = new Task([t1, t2, t3, t4, t5]);
        task.execute();
        assert.strictEqual(task.status, 'running');
        await task.toPromise();
        assert.strictEqual(task.status, 'fulfilled');
        assert.deepStrictEqual(r, [5, 1, 4, 2, 3]);
    });

    it('should fail if dependent task fails', async function () {
        const r = [];
        const newFn = (i: number, fail?: boolean) => (
            async () => {
                await delay(50 + (i * 5));
                if (fail)
                    throw new Error('test');
                r.push(i);
            });
        const t5 = new Task(newFn(5), {name: 't5'});
        const t1 = new Task(newFn(1), {name: 't1', dependencies: [t5]});
        const t4 = new Task(newFn(4, true), {name: 't4', dependencies: ['t1']});
        const t2 = new Task(newFn(2), {name: 't2', dependencies: [t4]});
        const t3 = new Task(newFn(3), {name: 't3', dependencies: ['t4']});
        const task = new Task([t1, t2, t3, t4, t5]);
        task.execute();
        assert.strictEqual(task.status, 'running');
        await task.toPromise(true);
        assert.strictEqual(task.status, 'failed');
        assert.deepStrictEqual(r, [5, 1]);
        assert.strictEqual(t4.status, 'failed');
        assert.strictEqual(t2.status, 'failed');
        assert.strictEqual(t3.status, 'failed');
    });

    it('should cancel if dependent task cancels', async function () {
        const r = [];
        const newFn = (i: number) => (
            async () => {
                await delay(50 + (i * 5));
                r.push(i);
            });
        const t5 = new Task(newFn(5), {name: 't5'});
        const t1 = new Task(newFn(1), {name: 't1', dependencies: [t5]});
        const t4 = new Task(newFn(4), {name: 't4', dependencies: ['t1']});
        const t2 = new Task(newFn(2), {name: 't2', dependencies: [t4]});
        const t3 = new Task(newFn(3), {name: 't3', dependencies: ['t4']});
        const task = new Task([t1, t2, t3, t4, t5]);
        task.execute();
        assert.strictEqual(task.status, 'running');
        await t5.toPromise();
        t4.cancel();
        await task.toPromise(true);
        assert.strictEqual(task.status, 'fulfilled');
        assert.deepStrictEqual(r, [5, 1]);
        assert.strictEqual(t4.status, 'cancelled');
        assert.strictEqual(t2.status, 'cancelled');
        assert.strictEqual(t3.status, 'cancelled');
    });

});
