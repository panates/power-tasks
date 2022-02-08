import assert from 'assert';
import './env';
import {Task, TaskQueue} from '../src';
import {delay} from '../src/utils';

const noOp = () => void (0);

describe.only('TaskQueue', function () {

    it('should construct', function () {
        const queue = new TaskQueue();
        assert.strictEqual(queue.maxQueue, undefined);
    });

    it('should construct with options', function () {
        const queue = new TaskQueue({
            maxQueue: 100,
            concurrency: 5
        });
        assert.strictEqual(queue.paused, false);
        assert.strictEqual(queue.maxQueue, 100);
        assert.strictEqual(queue.concurrency, 5);
    });

    it('should not exceed maxQueue', function () {
        const queue = new TaskQueue({
            maxQueue: 1
        });
        queue.enqueue(noOp);
        assert.throws(() => queue.enqueue(noOp), /exceeded/);
    });

    it('should execute sync function task', function (done) {
        const queue = new TaskQueue();
        queue.enqueue(() => {
            setTimeout(done, 5);
        });
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

    it('should task return a result', async function () {
        const queue = new TaskQueue();
        const result = await queue.enqueue(() => {
            return 123;
        });
        assert.strictEqual(result, 123);
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
                assert.strictEqual(i, 2);
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
        assert(p instanceof Task);
    });

    it('should add a task to first location in the queue', function (done) {
        const queue = new TaskQueue();
        const q = [];
        queue.on('finish', () => {
            try {
                assert.deepStrictEqual(q, [2, 1]);
            } catch (e) {
                return done(e);
            }
            done();
        });
        queue.enqueue(() => {
            q.push(1);
        });
        queue.enqueue(() => {
            q.push(2);
        }, true);
    });

    it('should execute next on error', function () {
        const queue = new TaskQueue();
        queue.enqueue(() => {
            throw new Error('test');
        }).catch(() => {
        });
        return queue.enqueue(() => Promise.resolve());
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
                assert.strictEqual(i, 1);
            } catch (e) {
                done(e);
            }
            done();
        });
    });

    it('should clear', function (done) {
        const queue = new TaskQueue();
        let err;
        queue.enqueue(async () => {
            await delay(10);
        });
        queue.enqueue(() => {
            err = new Error('Failed');
        });
        queue.clearQueue();
        queue.enqueue(() => done(err));
    });
});
