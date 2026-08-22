import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import { HelixMcpServer } from '../packages/mcp/src/index.js';

const directory = await mkdtemp(join(tmpdir(), 'helix-m11-demo-'));
try {
  const runtime = new HelixRuntime({ dataDirectory: directory });
  for (let index = 0; index < 4; index += 1) runtime.agents.register({ name: `demo-agent-${index}`, role: 'worker', capabilities: ['analysis', 'testing'] });
  const mcp = new HelixMcpServer(runtime, { actorRoles: { 'mcp-operator': 'operator', 'mcp-admin': 'admin' } });
  console.log(JSON.stringify({ step: 1, server: 'helix-m11', transport: ['stdio', 'streamable-http'], tools: mcp.registry.count(), resources: mcp.resources.length, prompts: mcp.prompts.length }, null, 2));
  console.log(JSON.stringify({ step: 2, discovery: (await mcp.listTools()).slice(0, 5) }, null, 2));
  console.log(JSON.stringify({ step: 3, agents: await mcp.execute('helix_agent_list', {}, { id: 'mcp-operator', role: 'operator' }) }, null, 2));
  const execution = await mcp.execute('helix_task_create', { goal: 'M11 deterministic MCP demo task' }, { id: 'mcp-operator', role: 'operator' });
  console.log(JSON.stringify({ step: 4, task: { id: (execution as { id: string }).id, status: (execution as { status: string }).status } }, null, 2));
  console.log(JSON.stringify({ step: 5, scheduler: await mcp.execute('helix_scheduler_tick', {}, { id: 'mcp-operator', role: 'operator' }) }, null, 2));
  console.log(JSON.stringify({ step: 6, assignments: await mcp.execute('helix_task_assign', {}, { id: 'mcp-operator', role: 'operator' }) }, null, 2));
  console.log(JSON.stringify({ step: 7, workers: await mcp.execute('helix_worker_pool_status', {}, { id: 'mcp-operator', role: 'operator' }) }, null, 2));
  console.log(JSON.stringify({ step: 8, memory: await mcp.execute('helix_memory_search', { query: 'M11 deterministic' }, { id: 'mcp-operator', role: 'operator' }) }, null, 2));
  console.log(JSON.stringify({ step: 9, metrics: await mcp.execute('helix_system_metrics', {}, { id: 'mcp-operator', role: 'operator' }) }, null, 2));
  console.log(JSON.stringify({ step: 10, audit: mcp.registry.audit.list(3) }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
