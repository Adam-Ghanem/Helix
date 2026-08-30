import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodingSessionStore } from '../packages/coding/src/index.js';

test('coding session store persists sessions and append-only evidence across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-coding-store-'));
  try {
    const stateFile = join(directory, 'coding.json');
    const store = new CodingSessionStore({ stateFile });
    await store.init();
    const session = await store.createSession({ goal: 'Improve parser', cwd: directory, adapter: 'deterministic' });
    assert.equal(session.status, 'created');
    assert.equal(session.attempt, 1);
    const first = await store.appendEvidence(session.id, { type: 'hook', data: { event: 'pre-task' } });
    const second = await store.appendEvidence(session.id, { type: 'test', data: { passed: true } });
    await store.updateSession(session.id, { status: 'completed', finalVerdict: 'accepted' });

    const restored = new CodingSessionStore({ stateFile });
    await restored.init();
    const loaded = await restored.getSession(session.id);
    assert.equal(loaded?.status, 'completed');
    assert.equal(loaded?.finalVerdict, 'accepted');
    assert.deepEqual(loaded?.evidenceIds, [first.id, second.id]);
    assert.deepEqual((await restored.evidenceForSession(session.id)).map((record) => record.id), [first.id, second.id]);
    assert.equal((await restored.listSessions())[0]?.id, session.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('coding session store rejects unknown sessions and protects append-only evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-coding-store-guard-'));
  try {
    const store = new CodingSessionStore({ stateFile: join(directory, 'coding.json') });
    await store.init();
    await assert.rejects(() => store.updateSession('missing', { status: 'failed' }), /unknown coding session/i);
    await assert.rejects(() => store.appendEvidence('missing', { type: 'failure', data: {} }), /unknown coding session/i);
    const session = await store.createSession({ goal: 'One', cwd: directory, adapter: 'deterministic' });
    await store.appendEvidence(session.id, { type: 'adapter-output', data: { output: 'ok' } });
    const evidence = await store.evidenceForSession(session.id);
    const mutated = evidence[0]!;
    mutated.data.output = 'tampered';
    assert.equal((await store.evidenceForSession(session.id))[0]?.data.output, 'ok');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
