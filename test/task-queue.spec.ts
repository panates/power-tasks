import './env';
import {Task, TaskQueue} from '../src';
import {delay} from '../src/utils';

const noOp = () => void (0);

describe('TaskQueue', function () {

    it('should construct', function () {
        const queue = new TaskQueue();
        expect(queue.maxQueue).toEqual(undefined);
    });

    it('should construct with options', function () {
        const queue = new TaskQueue({
            maxQueue: 100,
            concurrency: 5
        });
        expect(queue.paused).toEqual(false);
        expect(queue.maxQueue).toEqual(100);
        expect(queue.concurrency).toEqual(5);
    });

    it('should not exceed maxQueue', function () {
        const queue = new TaskQueue({
            maxQueue: 1
        });
        queue.enqueue(noOp);
        expect(() => queue.enqueue(noOp)).toThrow(/exceeded/);
    });

    it('should execute sync function task', async function () {
        const queue = new TaskQueue({concurrency: 1});
        queue.enqueue(async () => await delay(50));
        queue.enqueue(async () => await delay(50));
        await delay(5);
        expect(queue.running).toEqual(1);
        expect(queue.queued).toEqual(1);
        await queue.waitFor();
        expect(queue.running).toEqual(0);
        expect(queue.queued).toEqual(0);
    });

    it('should execute async function task', function (done) {
        const queue = new TaskQueue();
        queue.enqueue(async () => {
            await delay(5);
            done();
        });
    });

    it('should execute Task instance', function (done) {
        const queue = new TaskQueue();
        queue.enqueue(new Task(() => {
            setTimeout(done, 5);
        }));
    });

    it('should task return a TaskInstance', async function () {
        const queue = new TaskQueue();
        const task = queue.enqueue(() => {
            return 123;
        });
        expect(task).toBeInstanceOf(Task);
        const r = await task.toPromise();
        expect(r).toStrictEqual(123);
    });

    it('should emit "enqueue" event', function (done) {
        const queue = new TaskQueue();
        queue.on('enqueue', () => {
            done();
        });
        queue.enqueue(() => {
        });
    });

    it('should emit "finish" event after all task completed', function (done) {
        const queue = new TaskQueue();
        let i = 0;
        queue.on('finish', () => {
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

    it('should enqueue return Task instance', function () {
        const queue = new TaskQueue();
        const p = queue.enqueue(() => {
        });
        expect(p).toBeInstanceOf(Task);
    });

    it('should add a task to first location in the queue', async function () {
        const queue = new TaskQueue({concurrency: 1});
        const q = [];
        queue.enqueue(async () => {
            q.push(1);
        });
        queue.enqueue(async () => {
            q.push(2);
        });
        queue.enqueuePrepend(async () => {
            q.push(3);
        });
        await queue.waitFor();
        expect(q).toEqual([1, 3, 2]);
    });

    it('should execute next on error', function (done) {
        const queue = new TaskQueue();
        queue.enqueue(async () => {
            await delay(10);
            throw new Error('test');
        });
        queue.enqueue(async () => {
            await delay(10);
            done();
        });
    });

    it('should pause', function (done) {
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

    it('should clear', async function () {
        const queue = new TaskQueue({concurrency: 1});
        let err;
        queue.enqueue(async () => {
            await delay(10);
        });
        queue.enqueue(async () => {
            err = new Error('Failed');
        });
        queue.clearQueue();
        await queue.waitFor();
        expect(err).not.toBeDefined();
    });

    it('should cancel all tasks', async function () {
        const queue = new TaskQueue({concurrency: 1});
        queue.enqueue(async () => {
            await delay(10);
        });
        const t2 = queue.enqueue(async () => 0);
        const t3 = queue.enqueue(async () => 0);
        queue.cancelAll();
        await queue.waitFor();
        expect(t2.status).toEqual('cancelled');
        expect(t3.status).toEqual('cancelled');
        expect(queue.running).toEqual(0);
        expect(queue.queued).toEqual(0);
    });
});
