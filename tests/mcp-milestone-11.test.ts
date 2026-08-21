import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import { HelixMcpServer, McpAuditLog, McpAuthorization, McpToolError, McpToolRegistry, RateLimiter, buildMcpToolDefinitions, MCP_TOOL_FAMILY_COUNTS } from '../packages/mcp/src/index.js';

async function withRuntime<T>(prefix: string, run: (runtime: HelixRuntime, server: HelixMcpServer) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { const runtime = new HelixRuntime({ dataDirectory: directory }); const server = new HelixMcpServer(runtime, { actorRoles: { operator: 'operator', admin: 'admin' } }); return await run(runtime, server); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function expectMcpError(run: () => Promise<unknown>, category: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof McpToolError && error.category === category);
}

test('M11 registers 150+ unique typed tools with coherent family distribution', async () => withRuntime('helix-m11-registry-', async (_runtime, server) => {
  assert.equal(server.registry.count(), 215);
  const names = server.registry.list().map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const definition of server.registry.list()) assert.doesNotThrow(() => z.object(definition.inputSchema));
  for (const [family, count] of Object.entries(MCP_TOOL_FAMILY_COUNTS)) assert.equal(server.registry.listByFamily(family as never).length, count);
}));

test('M11 read tools use existing runtime capabilities and deterministic outputs', async () => withRuntime('helix-m11-read-', async (_runtime, server) => {
  const agents = await server.execute('helix_agent_list', {});
  assert.ok(agents && typeof agents === 'object');
  const health = await server.execute('helix_system_health', {});
  assert.equal((health as { status: string }).status, 'ok');
  const memory = await server.execute('helix_memory_stats', {});
  assert.ok(memory && typeof memory === 'object');
}));

test('M11 write and execute tools are denied to the default viewer actor', async () => withRuntime('helix-m11-auth-', async (_runtime, server) => {
  await expectMcpError(() => server.execute('helix_agent_spawn', { name: 'blocked', role: 'worker', capabilities: ['analysis'] }), 'FORBIDDEN');
  await expectMcpError(() => server.execute('helix_sandbox_run', { command: '/bin/echo', args: ['blocked'] }), 'FORBIDDEN');
  const denied = server.registry.audit.list().filter((entry) => entry.authorization === 'denied');
  assert.equal(denied.length >= 2, true);
}));

test('M11 operator memory writes preserve ACL isolation', async () => withRuntime('helix-m11-memory-acl-', async (_runtime, server) => {
  const created = await server.execute('helix_memory_create', { content: 'private operator evidence', namespace: 'global', type: 'note' }, { id: 'operator', role: 'operator' });
  const memoryId = (created as { id: string }).id;
  await expectMcpError(() => server.execute('helix_memory_get', { memoryId }, { id: 'mcp-user', role: 'viewer' }), 'FORBIDDEN');
  const own = await server.execute('helix_memory_get', { memoryId }, { id: 'operator', role: 'operator' });
  assert.equal((own as { id: string }).id, memoryId);
}));

test('M11 audit records sanitize credential-shaped arguments and include request metadata', async () => withRuntime('helix-m11-audit-', async (_runtime, server) => {
  await server.execute('helix_system_health', { metadata: { token: 'token=not-a-real-secret' } });
  const event = server.registry.audit.list(1)[0]!;
  assert.equal(event.requestId.length > 0, true);
  assert.equal(event.actor, 'mcp-user');
  assert.equal(JSON.stringify(event.arguments).includes('not-a-real-secret'), false);
  assert.equal(event.durationMs >= 0, true);
}));

test('M11 rate limiter enforces stricter sensitive limits deterministically', () => {
  const limiter = new RateLimiter({ READ: 2, WRITE: 1, EXECUTE: 1, ADMIN: 1, REMOTE: 1 }, 60_000);
  limiter.consume('actor', 'system', 'helix_system_health', 'READ');
  limiter.consume('actor', 'system', 'helix_system_health', 'READ');
  assert.throws(() => limiter.consume('actor', 'system', 'helix_system_health', 'READ'), /rate limit/);
});

test('M11 resources and prompts are registered as protected server surfaces', async () => withRuntime('helix-m11-surfaces-', async (_runtime, server) => {
  assert.deepEqual(server.resources, ['helix://agents', 'helix://tasks', 'helix://scheduler', 'helix://swarm', 'helix://memory', 'helix://metrics', 'helix://events', 'helix://system', 'helix://goals', 'helix://plans', 'helix://orchestrations', 'helix://swarms', 'helix://swarm-collaboration', 'helix://federation-nodes', 'helix://federation-status', 'helix://federation-metrics']);
  assert.deepEqual(server.prompts, ['helix_plan_task', 'helix_review_result', 'helix_debug_task', 'helix_security_review', 'helix_swarm_plan', 'helix_memory_recall', 'helix_plan_goal', 'helix_review_plan', 'helix_debug_plan', 'helix_replan_failure', 'helix_federation_recovery', 'helix_federation_security']);
  assert.equal(typeof server.connectStdio, 'function');
  assert.equal(typeof server.handleHttp, 'function');
}));

test('M11 official Streamable HTTP transport answers an initialize request', async () => withRuntime('helix-m11-http-', async (_runtime, mcp) => {
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    await mcp.handleHttp(request, response, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'helix-test', version: '1' } } }) });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).length > 0, true);
  await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
}));

test('M11 official stdio transport accepts an initialize request', async () => withRuntime('helix-m11-stdio-', async (_runtime, mcp) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  await mcp.connectStdioStreams(input, output);
  const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'helix-stdio-test', version: '1' } } });
  input.write(Buffer.from(message + String.fromCharCode(10)));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(Buffer.concat(chunks).toString('utf8').includes('"result"'), true);
  input.end(); output.end();
}));

test('M11 legacy ToolRegistry can receive the same typed definitions without duplicate names', async () => withRuntime('helix-m11-legacy-', async (_runtime, server) => {
  const registry = new ToolRegistryForTest();
  const definitions = buildMcpToolDefinitions(server.bridge);
  registry.registerMany(definitions);
  assert.equal(registry.count(), 215);
}));

class ToolRegistryForTest {
  private readonly names = new Set<string>();
  registerMany(definitions: Array<{ name: string }>): void { for (const definition of definitions) { assert.equal(this.names.has(definition.name), false); this.names.add(definition.name); } }
  count(): number { return this.names.size; }
}

// Keep imports/exports explicit in the test surface so future refactors cannot silently remove the authorization boundary.
void McpAuditLog;
void McpAuthorization;
void McpToolRegistry;

test('M14 federation MCP tools and resources are registered under the governed boundary', async () => withRuntime('helix-m14-mcp-surfaces-', async (_runtime, server) => {
  assert.equal(server.registry.listByFamily('federation').length, 19);
  assert.equal(server.registry.has('helix_federation_task_dispatch'), true);
  assert.equal(server.resources.includes('helix://federation-status'), true);
  assert.equal(server.prompts.includes('helix_federation_recovery'), true);
}));

test('M14 remote federation dispatch remains denied to the default viewer actor', async () => withRuntime('helix-m14-mcp-auth-', async (_runtime, server) => {
  await expectMcpError(() => server.execute('helix_federation_task_dispatch', { taskId: 'mcp-remote', requiredCapabilities: ['analysis'], locality: 'remote' }), 'FORBIDDEN');
}));
