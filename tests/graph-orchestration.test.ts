import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeGraph, GraphValidationError, validateGraph } from '../packages/graph/src/index.js';

test('validates unknown dependencies and cycles', () => {
  assert.throws(() => validateGraph([{ id: 'a', dependsOn: ['missing'], run: () => 1 }]), GraphValidationError);
  assert.throws(() => validateGraph([
    { id: 'a', dependsOn: ['b'], run: () => 1 },
    { id: 'b', dependsOn: ['a'], run: () => 1 },
  ]), GraphValidationError);
});

test('executes independent tasks concurrently and respects dependencies', async () => {
  const order: string[] = [];
  const result = await executeGraph([
    { id: 'a', run: async () => { await new Promise((r) => setTimeout(r, 15)); order.push('a'); return 2; } },
    { id: 'b', run: async () => { await new Promise((r) => setTimeout(r, 5)); order.push('b'); return 3; } },
    { id: 'c', dependsOn: ['a', 'b'], run: ({ input }) => { order.push('c'); return Number(input) + 1; } },
  ], { concurrency: 2, input: 4 });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.results.get('c')?.value, 5);
  assert.deepEqual(order.slice(-1), ['c']);
});

test('retries failed tasks and records attempt count', async () => {
  let attempts = 0;
  const result = await executeGraph([{ id: 'unstable', retries: 2, run: () => {
    attempts += 1;
    if (attempts < 3) throw new Error('transient');
    return 'ok';
  } }]);
  assert.equal(result.status, 'succeeded');
  assert.equal(attempts, 3);
  assert.equal(result.results.get('unstable')?.attempts, 3);
});

test('fails dependents when an upstream task exhausts retries', async () => {
  const result = await executeGraph([
    { id: 'root', retries: 1, run: () => { throw new Error('permanent'); } },
    { id: 'dependent', dependsOn: ['root'], run: () => 'never' },
  ]);
  assert.equal(result.status, 'failed');
  assert.equal(result.results.get('root')?.status, 'failed');
  assert.equal(result.results.get('root')?.attempts, 2);
  assert.equal(result.results.get('dependent')?.status, 'cancelled');
});

test('cancels pending and running work through AbortSignal', async () => {
  const controller = new AbortController();
  let started = false;
  const resultPromise = executeGraph([
    { id: 'long', run: async ({ signal }) => {
      started = true;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      resolve();
    } },
    { id: 'pending', dependsOn: ['long'], run: () => 'never' },
  ], { signal: controller.signal });
  while (!started) await new Promise((r) => setTimeout(r, 1));
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.results.get('long')?.status, 'cancelled');
  assert.equal(result.results.get('pending')?.status, 'cancelled');
});
