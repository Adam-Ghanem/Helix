import test from 'node:test';
import assert from 'node:assert/strict';
import { HookEngine, HookContext } from '../packages/hooks/src/index.js';

function context(event: HookContext['event'] = 'pre-task'): HookContext {
  return { event, sessionId: 'session-1', cwd: process.cwd(), timestamp: new Date().toISOString(), payload: {}, metadata: {} };
}

test('hook engine executes matched hooks by priority and registration order', async () => {
  const engine = new HookEngine();
  const order: string[] = [];
  engine.register({ id: 'second-a', events: ['pre-task'], priority: 20, critical: false, timeoutMs: 100, handler: async () => { order.push('second-a'); return { hookId: 'second-a', action: 'continue', annotations: { second: true } }; } });
  engine.register({ id: 'first', events: ['pre-task'], priority: 10, critical: false, timeoutMs: 100, handler: async () => { order.push('first'); return { hookId: 'first', action: 'continue', evidence: ['prepared'] }; } });
  engine.register({ id: 'second-b', events: ['pre-task'], priority: 20, critical: false, timeoutMs: 100, matcher: (value) => value.sessionId === 'session-1', handler: async () => { order.push('second-b'); return { hookId: 'second-b', action: 'continue', warnings: ['note'] }; } });
  engine.register({ id: 'not-matched', events: ['post-task'], priority: 1, critical: false, timeoutMs: 100, handler: async () => { order.push('not-matched'); return { hookId: 'not-matched', action: 'continue' }; } });
  const result = await engine.run(context());
  assert.deepEqual(order, ['first', 'second-a', 'second-b']);
  assert.equal(result.action, 'continue');
  assert.deepEqual(result.annotations, { second: true });
  assert.deepEqual(result.evidence, ['prepared']);
  assert.deepEqual(result.warnings, ['note']);
});

test('block stops ordinary hooks but alwaysRun audit hooks still execute', async () => {
  const engine = new HookEngine();
  const order: string[] = [];
  engine.register({ id: 'blocker', events: ['pre-command'], priority: 10, critical: true, timeoutMs: 100, handler: async () => { order.push('blocker'); return { hookId: 'blocker', action: 'block', reason: 'denied' }; } });
  engine.register({ id: 'skipped', events: ['pre-command'], priority: 20, critical: false, timeoutMs: 100, handler: async () => { order.push('skipped'); return { hookId: 'skipped', action: 'continue' }; } });
  engine.register({ id: 'audit', events: ['pre-command'], priority: 30, critical: false, timeoutMs: 100, alwaysRun: true, handler: async () => { order.push('audit'); return { hookId: 'audit', action: 'continue', evidence: ['blocked-attempt-recorded'] }; } });
  const result = await engine.run(context('pre-command'));
  assert.deepEqual(order, ['blocker', 'audit']);
  assert.equal(result.action, 'block');
  assert.equal(result.reason, 'denied');
  assert.deepEqual(result.evidence, ['blocked-attempt-recorded']);
});

test('critical timeout blocks while non-critical timeout warns and continues', async () => {
  const critical = new HookEngine();
  critical.register({ id: 'slow-critical', events: ['pre-tool'], priority: 1, critical: true, timeoutMs: 5, handler: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { hookId: 'slow-critical', action: 'continue' }; } });
  const criticalResult = await critical.run(context('pre-tool'));
  assert.equal(criticalResult.action, 'block');
  assert.match(criticalResult.reason ?? '', /timed out/i);

  const optional = new HookEngine();
  optional.register({ id: 'slow-optional', events: ['post-tool'], priority: 1, critical: false, timeoutMs: 5, handler: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { hookId: 'slow-optional', action: 'continue' }; } });
  optional.register({ id: 'next', events: ['post-tool'], priority: 2, critical: false, timeoutMs: 100, handler: async () => ({ hookId: 'next', action: 'continue', annotations: { next: true } }) });
  const optionalResult = await optional.run(context('post-tool'));
  assert.equal(optionalResult.action, 'continue');
  assert.match(optionalResult.warnings.join(' '), /timed out/i);
  assert.deepEqual(optionalResult.annotations, { next: true });
});

test('hook engine rejects duplicate ids and invalid timeouts', () => {
  const engine = new HookEngine();
  engine.register({ id: 'same', events: ['pre-task'], priority: 1, critical: false, timeoutMs: 50, handler: async () => ({ hookId: 'same', action: 'continue' }) });
  assert.throws(() => engine.register({ id: 'same', events: ['post-task'], priority: 2, critical: false, timeoutMs: 50, handler: async () => ({ hookId: 'same', action: 'continue' }) }), /already registered/i);
  assert.throws(() => engine.register({ id: 'bad-timeout', events: ['pre-task'], priority: 1, critical: false, timeoutMs: 0, handler: async () => ({ hookId: 'bad-timeout', action: 'continue' }) }), /timeout/i);
});
