import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelixDaemon, daemonPaths, enqueueExecution } from '../packages/daemon/src/index.js';
import { LeaseScheduler } from '../packages/scheduler/src/index.js';
import { DurableTaskQueue, WorkerPool } from '../packages/workers/src/index.js';

test('durable worker queue persists jobs and completes leased work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-worker-queue-'));
  try {
    const queueFile = join(directory, 'tasks.json');
    const leaseFile = join(directory, 'leases.json');
    const queue = new DurableTaskQueue({ stateFile: queueFile });
    const scheduler = new LeaseScheduler({ stateFile: leaseFile, leaseMs: 1_000, maxConcurrency: 1 });
    const created = await queue.enqueue('analysis', { target: 'repo' });
    const restored = new DurableTaskQueue({ stateFile: queueFile });
    assert.equal((await restored.get(created.id)).status, 'queued');

    const claimed = await restored.claim('worker-a', scheduler, ['analysis']);
    assert.equal(claimed?.id, created.id);
    assert.equal(claimed?.attempts, 1);
    await restored.heartbeat(created.id, 'worker-a', scheduler);
    const completed = await restored.complete(created.id, 'worker-a', scheduler, { ok: true });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.result, { ok: true });
    assert.equal((await restored.stats()).completed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable worker queue recovers abandoned leases for retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-worker-recovery-'));
  try {
    const queue = new DurableTaskQueue({ stateFile: join(directory, 'tasks.json') });
    const scheduler = new LeaseScheduler({ stateFile: join(directory, 'leases.json'), leaseMs: 10, maxConcurrency: 1 });
    const created = await queue.enqueue('analysis', {}, { maxAttempts: 2 });
    const claimed = await queue.claim('worker-a', scheduler);
    assert.equal(claimed?.status, 'running');
    scheduler.recoverExpired(Date.now() + 100);
    const recovered = await queue.recoverOrphans(scheduler);
    assert.equal(recovered.length, 1);
    const task = await queue.get(created.id);
    assert.equal(task.status, 'queued');
    assert.equal(task.attempts, 1);
    assert.match(task.error ?? '', /abandoned worker lease/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker pool retries failed jobs and records the successful result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-worker-pool-'));
  try {
    const queue = new DurableTaskQueue({ stateFile: join(directory, 'tasks.json') });
    const scheduler = new LeaseScheduler({ stateFile: join(directory, 'leases.json'), leaseMs: 1_000, maxConcurrency: 1 });
    const pool = new WorkerPool({ queue, scheduler, concurrency: 1, pollIntervalMs: 5, heartbeatIntervalMs: 50, retryDelayMs: 5 });
    let calls = 0;
    pool.register('flaky', async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient worker failure');
      return { recovered: true };
    });
    const created = await queue.enqueue('flaky', {}, { maxAttempts: 2 });
    pool.start();
    const completed = await waitFor(async () => {
      const task = await queue.get(created.id);
      return task.status === 'completed' ? task : undefined;
    });
    await pool.stop();
    assert.ok(completed);
    assert.equal(completed?.attempts, 2);
    assert.deepEqual(completed?.result, { recovered: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('daemon consumes a persisted background execution job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-daemon-'));
  const daemon = new HelixDaemon({ dataDirectory: directory, concurrency: 1, leaseMs: 1_000, pollIntervalMs: 5, heartbeatIntervalMs: 50, statusIntervalMs: 20 });
  try {
    await daemon.start();
    const queued = await enqueueExecution(directory, { goal: 'Review the durable worker architecture' }, { maxAttempts: 1 });
    const reader = new DurableTaskQueue({ stateFile: daemonPaths(directory).queueFile });
    const completed = await waitFor(async () => {
      const task = await reader.get(queued.id);
      return task.status === 'completed' ? task : undefined;
    });
    assert.ok(completed);
    assert.equal((completed?.result as { status?: string }).status, 'completed');
    const state = await daemon.status();
    assert.equal(state.pool.queue.completed, 1);
    assert.equal(state.pool.workers.length, 1);
  } finally {
    await daemon.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor<T>(read: () => Promise<T | undefined>, attempts = 200): Promise<T | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}
