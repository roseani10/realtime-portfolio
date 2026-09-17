import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerPool } from '../src/media/workerPool.js';
import { FakeWorker } from './fakes.js';

const makePool = (size) =>
  new WorkerPool({ size, createWorker: async () => new FakeWorker(1000 + Math.random()), logger: { error() {} } });

test('starts the requested number of workers', async () => {
  const pool = await makePool(3).start();
  assert.equal(pool.slots.length, 3);
});

test('routers are placed on the least-loaded worker', async () => {
  const pool = await makePool(2).start();
  const r1 = await pool.createRouter({});
  const r2 = await pool.createRouter({});
  const r3 = await pool.createRouter({});
  assert.notEqual(r1.worker, r2.worker, 'second router goes to the empty worker');
  assert.deepEqual(pool.stats.map((s) => s.routers).sort(), [1, 2]);
  assert.ok([r1.worker, r2.worker].includes(r3.worker));
});

test('closing a router frees its slot', async () => {
  const pool = await makePool(1).start();
  const r = await pool.createRouter({});
  assert.equal(pool.stats[0].routers, 1);
  r.close();
  assert.equal(pool.stats[0].routers, 0);
});

test('refuses a pool of size zero', () => {
  assert.throws(() => makePool(0), /at least one worker/);
});
