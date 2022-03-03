import './env';
import {Task} from '../src';
import {delay} from '../src/utils';

const noOp = () => void (0);
const logUpdates = (messages: string[]) => {
    return (v, t) => {
        messages.push((t.name || 'task') + ':' + t.status +
            (t.status === 'waiting' ? ':' + t.waitingFor.name : ''));
    };
}

describe('Task', function () {

    it('should execute simple function', async function () {
        let i = 0;
        const task = new Task(() => ++i);
        const messages: string[] = [];
        const onUpdate = logUpdates(messages);
        task.on('update', onUpdate);
        const r = await task.toPromise();
        expect(messages).toStrictEqual([
            "task:running",
            "task:fulfilled"
        ]);
        expect(r).toEqual(1);
        expect(i).toEqual(1);
        expect(task.message).toEqual('Task completed');
    });

    it('should execute async function', async function () {
        let i = 0;
        const task = new Task(async () => {
            await delay(50);
            return ++i;
        });
        const messages: string[] = [];
        const onUpdate = logUpdates(messages);
        task.on('update', onUpdate);
        const r = await task.toPromise();
        expect(messages).toStrictEqual([
            "task:running",
            "task:fulfilled"
        ]);
        expect(r).toEqual(1);
        expect(i).toEqual(1);
    });

    it('should cancel', async function () {
        let i = 0;
        const task = new Task(async () => {
            await delay(20);
            i++;
        }, {
            cancel: () => {
                i++;
            }
        });
        const messages: string[] = [];
        const onUpdate = logUpdates(messages);
        task.on('update', onUpdate);
        await task.start();
        await delay(10);
        task.cancel();
        await task.toPromise();
        expect(messages).toStrictEqual([
            "task:running",
            "task:cancelling",
            "task:cancelled"
        ]);
        expect(i).toEqual(1);
    });

    it('should "cancel" do nothing after finish', async function () {
        const task = new Task(() => 0);
        await task.toPromise();
        expect(task.status).toEqual('fulfilled');
        task.cancel();
        await task.toPromise();
        expect(task.status).toEqual('fulfilled');
    });

    it('should force cancel after timeout', async function () {
        const task = new Task(async () => {
            await delay(250);
        }, {
            cancelTimeout: 5
        });
        await task.start();
        await delay(5);
        const t = Date.now();
        task.cancel();
        await task.toPromise();
        expect(Date.now() - t).toBeLessThanOrEqual(50);
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
        const r = await task.toPromise();
        expect(task.status).toEqual('fulfilled');
        expect(r).toEqual(10);
        expect(task.children).toBeDefined();
    });

    it('should add child tasks on the fly', async function () {
        let i = 0;
        const task = new Task((task1) => task1.children.length, {
            children: async () => {
                return [
                    new Task(() => {
                        i++;
                    }, {name: 't1'}),
                    new Task(async () => {
                        i++;
                    }, {name: 't2'})
                ]
            }
        });
        await task.toPromise();
        expect(i).toEqual(2);
        expect(task.status).toEqual('fulfilled');
        expect(task.children).toBeDefined();
        expect(task.children.length).toEqual(2);
        expect(task.children[0].status).toEqual('fulfilled');
        expect(task.children[1].status).toEqual('fulfilled');
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
                    if (task.status === 'running')
                        fulfilled.push(x);
                }, {
                    name: 't' + x,
                    cancel: async () => {
                        await delay(5);
                        cancelled.push(x);
                    }
                }
            ))
        }
        const task = new Task(() => 0, {
            children,
            concurrency: 10,
            name: 'main'
        });
        task.start();
        await delay(10);
        task.cancel();
        await task.toPromise();
        expect(task.status).toEqual('cancelled');
        for (const t of task.children) {
            expect(t.status).toEqual('cancelled');
        }
        expect(fulfilled.length).toEqual(0);
        expect(cancelled).toEqual([5, 4, 3, 2, 1]);
    });

    it('should cancel remaining children, if any child fails (bail=true, serial=true)', async function () {
        let i = 0;
        let c = 0;
        const task = new Task([
            new Task(async () => {
                await delay(10);
                throw new Error('test');
            }),
            new Task(async () => {
                await delay(50);
                i++;
            }, {cancel: () => c++}),
            new Task(async () => {
                await delay(60);
                i++;
            }, {cancel: () => c++}),
        ], {bail: true, serial: true});
        await task.toPromise().catch(noOp);
        expect(task.status).toEqual('failed');
        expect(i).toEqual(0);
        expect(c).toEqual(0);
        expect(task.children[0].status).toEqual('failed');
        expect(task.children[1].status).toEqual('cancelled');
        expect(task.children[2].status).toEqual('cancelled');
    });

    it('should cancel running children, if any child fails (bail=true, serial=false)', async function () {
        let i = 0;
        let c = 0;
        const task = new Task([
            new Task(async () => {
                await delay(10);
                throw new Error('test');
            }),
            new Task(async () => {
                await delay(50);
                i++;
            }, {cancel: () => c++}),
            new Task(async () => {
                await delay(60);
                i++;
            }, {cancel: () => c++}),
        ], {bail: true, serial: false});
        await task.toPromise().catch(noOp);
        expect(task.status).toEqual('failed');
        expect(i).toEqual(0);
        expect(c).toEqual(2);
        expect(task.children[0].status).toEqual('failed');
        expect(task.children[1].status).toEqual('cancelled');
        expect(task.children[2].status).toEqual('cancelled');
    });

    it('should fail but run all children, if any child fails (bail=false, serial=false)', async function () {
        let i = 0;
        let c = 0;
        const task = new Task([
            new Task(async () => {
                await delay(10);
                throw new Error('test');
            }),
            new Task(async () => {
                await delay(50);
                i++;
            }, {cancel: () => c++}),
            new Task(async () => {
                await delay(60);
                i++;
            }, {cancel: () => c++}),
        ], {bail: false, serial: false});
        await task.toPromise().catch(noOp);
        expect(task.status).toEqual('failed');
        expect(i).toEqual(2);
        expect(c).toEqual(0);
        expect(task.children[0].status).toEqual('failed');
        expect(task.children[1].status).toEqual('fulfilled');
        expect(task.children[2].status).toEqual('fulfilled');
    });

    it('should fail but run all children, if any child fails (bail=false, serial=true)', async function () {
        let i = 0;
        let c = 0;
        const task = new Task([
            new Task(async () => {
                await delay(10);
                throw new Error('test');
            }),
            new Task(async () => {
                await delay(50);
                i++;
            }, {cancel: () => c++}),
            new Task(async () => {
                await delay(60);
                i++;
            }, {cancel: () => c++}),
        ], {bail: false, serial: true});
        await task.toPromise().catch(noOp);
        expect(task.status).toEqual('failed');
        expect(i).toEqual(2);
        expect(c).toEqual(0);
        expect(task.children[0].status).toEqual('failed');
        expect(task.children[1].status).toEqual('fulfilled');
        expect(task.children[2].status).toEqual('fulfilled');
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
        await task.toPromise();
        expect(arr.length).toEqual(2);
        expect(task.status).toEqual('fulfilled');
        expect(task.children).toBeDefined();
        expect(task.children.length).toEqual(2);
        expect(arr[0]).toEqual(2);
        expect(arr[1]).toEqual(1);
    });

    it('should limit concurrent tasks', async function () {
        const a = [];
        let running = 0;
        for (let i = 0; i < 8; i++) {
            a.push(new Task(async () => {
                running++;
                if (running > 2)
                    throw new Error('Failed');
                await delay(50);
            }).on('finish', () => running--));
        }
        const task = new Task(a, {concurrency: 2});
        await task.toPromise();
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
        const task = new Task([t1, t2, t3, t4, t5], {name: 'main'});

        const messages: string[] = [];
        const onUpdate = logUpdates(messages);
        task.on('update', onUpdate);
        t1.on('update', onUpdate);
        t2.on('update', onUpdate);
        t3.on('update', onUpdate);
        t4.on('update', onUpdate);
        t5.on('update', onUpdate);

        await task.toPromise();
        expect(task.status).toEqual('fulfilled');
        expect(r).toEqual([5, 1, 4, 2, 3]);
        expect(messages).toStrictEqual([
            "main:running",
            "t1:waiting:t5",
            "t2:waiting:t4",
            "t3:waiting:t4",
            "t4:waiting:t1",
            "t5:running",
            "t5:fulfilled",
            "t1:running",
            "t1:fulfilled",
            "t4:running",
            "t4:fulfilled",
            "t2:running",
            "t3:running",
            "t2:fulfilled",
            "t3:fulfilled",
            "main:fulfilled"
        ]);
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
        const task = new Task([t1, t2, t3, t4, t5], {name: 'main'});

        const messages: string[] = [];
        const onUpdate = logUpdates(messages);
        task.on('update', onUpdate);
        t1.on('update', onUpdate);
        t2.on('update', onUpdate);
        t3.on('update', onUpdate);
        t4.on('update', onUpdate);
        t5.on('update', onUpdate);

        await task.toPromise().catch(noOp);
        expect(task.status).toEqual('failed');
        expect(r).toEqual([5, 1]);
        expect(t4.status).toEqual('failed');
        expect(t2.status).toEqual('failed');
        expect(t3.status).toEqual('failed');
        expect(messages).toStrictEqual([
            "main:running",
            "t1:waiting:t5",
            "t2:waiting:t4",
            "t3:waiting:t4",
            "t4:waiting:t1",
            "t5:running",
            "t5:fulfilled",
            "t1:running",
            "t1:fulfilled",
            "t4:running",
            "t4:failed",
            "t2:failed",
            "t3:failed",
            "main:failed"
        ]);
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
        task.start();
        await t5.toPromise();
        t4.cancel();
        await task.toPromise();
        expect(task.status).toEqual('fulfilled');
        expect(r).toEqual([5, 1]);
        expect(t4.status).toEqual('cancelled');
        expect(t2.status).toEqual('cancelled');
        expect(t3.status).toEqual('cancelled');
    });

    it('should run exclusive tasks one at a time', async function () {
        const r = [];
        const newFn = (i: number) => (
            async () => {
                await delay(50);
                r.push(i);
            });

        const t1 = new Task(newFn(1), {name: 't1'});
        const t2 = new Task(newFn(2), {name: 't2', exclusive: true});
        const t3 = new Task(newFn(3), {name: 't3'});
        const t4 = new Task(newFn(4), {name: 't4'});
        const task = new Task([t1, t2, t3, t4], {name: 'main', concurrency: 10});

        const messages: string[] = [];
        const onUpdate = logUpdates(messages);
        task.on('update', onUpdate);
        t1.on('update', onUpdate);
        t2.on('update', onUpdate);
        t3.on('update', onUpdate);
        t4.on('update', onUpdate);

        await task.toPromise();
        expect(task.status).toEqual('fulfilled');
        expect(r).toEqual([1, 2, 3, 4]);
        expect(messages).toStrictEqual([
            "main:running",
            "t1:running",
            "t1:fulfilled",
            "t2:running",
            "t2:fulfilled",
            "t3:running",
            "t4:running",
            "t3:fulfilled",
            "t4:fulfilled",
            "main:fulfilled"
        ]);
    });

});
