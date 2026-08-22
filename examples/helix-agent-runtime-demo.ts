import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRuntimeError } from '../packages/agent-runtime/src/index.js';
import type { AgentProviderInput, AgentProviderResponse } from '../packages/agent-runtime/src/index.js';
import { HelixRuntime, DeterministicProvider } from '../packages/runtime/src/index.js';

class DemoProvider extends DeterministicProvider {
  private readonly attempts = new Map<string, number>();
  override async executeAgent(input: AgentProviderInput): Promise<AgentProviderResponse> {
    const key = input.task.title;
    const attempt = (this.attempts.get(key) ?? 0) + 1; this.attempts.set(key, attempt);
    if (input.task.title.includes('inspect') && input.iteration === 1) return { decision: { type: 'tool_call', toolName: 'filesystem.list', arguments: { path: '.' } }, usage: { tokens: 0, costUsd: 0, model: 'deterministic-local' } };
    if (input.task.title.includes('inspect') && input.iteration === 2) return { decision: { type: 'tool_call', toolName: 'filesystem.read', arguments: { path: 'README.md' } }, usage: { tokens: 0, costUsd: 0, model: 'deterministic-local' } };
    if (input.task.title.includes('tool failure') && attempt === 1) return { decision: { type: 'tool_call', toolName: 'demo.flaky', arguments: { value: 'first attempt' } }, usage: { tokens: 0, costUsd: 0, model: 'deterministic-local' } };
    if (input.task.title.includes('tool failure') && attempt > 1) return { decision: { type: 'final', content: 'Recovered after retry' }, usage: { tokens: 0, costUsd: 0, model: 'deterministic-local' } };
    if (input.task.title.includes('policy denial')) return { decision: { type: 'tool_call', toolName: 'filesystem.write', arguments: { path: 'blocked.txt', content: 'blocked' } }, usage: { tokens: 0, costUsd: 0, model: 'deterministic-local' } };
    return { decision: { type: 'final', content: `Completed ${input.task.title}` }, usage: { tokens: 0, costUsd: 0, model: 'deterministic-local' } };
  }
}

async function main(): Promise<void> {
  const dataDirectory = await mkdtemp(join('/tmp', 'helix-m17-demo-')); const runtime = new HelixRuntime({ dataDirectory, learningAsync: false, provider: new DemoProvider() });
  try {
    await runtime.init();
    runtime.policy.addRule({ resource: 'demo.flaky', action: 'allow', subjects: ['*'] });
    for (let index = runtime.agents.list().length; index < 100; index += 1) runtime.agents.register({ name: `m17-agent-${index}`, role: index % 3 === 0 ? 'researcher' : index % 3 === 1 ? 'coder' : 'tester', capabilities: ['analysis', 'coding', 'testing'] });
    const agents = runtime.agents.list(); const coder = agents.find((agent) => agent.name === 'coder') ?? agents[0]!; const tester = agents.find((agent) => agent.name === 'tester') ?? agents[1]!; const reviewer = agents.find((agent) => agent.name === 'reviewer') ?? agents[2]!;
    const swarm = await runtime.swarms.create({ name: 'm17-demo-swarm', goalId: 'm17-demo-goal', topology: 'pipeline', maxAgents: 3 }); await runtime.swarms.addAgent(swarm.id, coder.id, ['IMPLEMENTER']);
    const inspect = await runtime.runAgent(coder.id, { title: 'inspect project', description: 'Inspect files before implementation.' }, { swarmId: swarm.id, config: { maxIterations: 5, maxToolCalls: 4 } });
    runtime.agentRuntime.registerTool({ name: 'demo.flaky', description: 'Controlled demo failure/recovery tool', inputSchema: { required: ['value'], properties: { value: 'string' } }, risk: 'low', category: 'READ', permissions: [], execute: async (input) => { if (String(input.value).includes('first')) throw new AgentRuntimeError('network', 'temporary demo tool failure', true); return { recovered: true }; } });
    const failed = await runtime.runAgent(coder.id, { title: 'tool failure recovery', description: 'Demonstrate one tool failure and bounded retry.' }, { config: { noMemory: true, maxIterations: 3, maxToolCalls: 2 } });
    const recovered = failed.status === 'failed' ? await runtime.runAgent(coder.id, { title: 'tool failure recovery', description: 'Retry the failed deterministic task.' }, { config: { noMemory: true, maxIterations: 2, maxToolCalls: 1 } }) : failed;
    const denied = await runtime.runAgent(coder.id, { title: 'policy denial', description: 'Attempt a write that must be blocked by policy.' }, { config: { noMemory: true, maxIterations: 2, maxToolCalls: 1 } });
    const sandbox = await runtime.execute({ goal: 'run a governed sandbox verification', sandbox: { enabled: true, backend: 'local', policy: { workspacePath: process.cwd(), allowedExecutables: ['echo'] }, command: { command: 'echo', args: ['sandbox-ok'] } } });
    const testerResult = await runtime.runAgent(tester.id, { title: 'run tests', description: 'Run a bounded tester review.' }, { config: { noMemory: true, maxIterations: 2 } });
    const reviewerResult = await runtime.runAgent(reviewer.id, { title: 'review result', description: 'Review the evidence and report the final result.' }, { config: { noMemory: true, maxIterations: 2 } });
    const snapshot = await runtime.controlPlane.snapshot(); const events = await runtime.events.read(); const traces = runtime.controlPlane.listTraces(20);
    console.log(JSON.stringify({ demo: 'M17 real agent runtime', agents: agents.length, swarm: { id: swarm.id, topology: runtime.swarms.get(swarm.id).topology, memberCount: runtime.swarms.get(swarm.id).members.length }, pipeline: ['planner', 'swarm-formation', 'scheduler', 'worker', 'agent-runtime', 'provider-tools', 'sandbox', 'tester', 'reviewer', 'learning'], results: [inspect, failed, recovered, denied, testerResult, reviewerResult].map((result) => ({ agentId: result.agentId, taskId: result.taskId, provider: result.provider, iterations: result.iterations, toolCalls: result.toolCalls.length, durationMs: result.durationMs, status: result.status, output: result.output, memoriesCreated: result.memoriesCreated, traceId: result.traceId })), sandbox: { status: sandbox.status, result: sandbox.result }, learnedMemoryCount: snapshot.memory.total, eventCount: events.length, traceCount: traces.length, policyDenials: events.filter((event) => event.type === 'agent.policy.denied').length, successfulRecovery: recovered.status === 'completed', externalProvider: runtime.provider.name !== 'deterministic-local', limitations: ['deterministic provider only', 'M13 swarm formation and membership are real but local/process-scoped', 'local sandbox isolation is best effort unless Docker is configured'] }, null, 2));
  } finally { await runtime.stopFederationRuntime().catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 25)); await rm(dataDirectory, { recursive: true, force: true }); }
}
await main();
