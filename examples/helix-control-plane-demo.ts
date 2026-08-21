import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HelixRuntime } from '../packages/runtime/src/index.js';

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function removeDirectory(directory: string): Promise<void> { for (let attempt = 0; attempt < 8; attempt += 1) { try { await rm(directory, { recursive: true, force: true }); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; await sleep(100); } } await rm(directory, { recursive: true, force: true }); }

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-control-plane-demo-'));
  const runtime = new HelixRuntime({ dataDirectory: directory, learningAsync: false });
  try {
    await runtime.init();
    while (runtime.agents.list().length < 100) { const index = runtime.agents.list().length; runtime.agents.register({ name: `demo-agent-${index}`, role: index % 3 === 0 ? 'reviewer' : 'worker', capabilities: ['analysis', index % 2 ? 'coding' : 'testing'] }); }
    const control = runtime.controlPlane;
    const firstAgent = runtime.agents.list()[0]!;
    const execution = await runtime.execute({ goal: 'Operate the M16 control plane through the canonical Helix worker path', budget: { maxAgents: 8, maxTasks: 8 } });
    let sandboxStatus = 'completed';
    try { await runtime.execute({ goal: 'Run a governed sandbox check', sandbox: { enabled: true, backend: 'local', policy: { allowedExecutables: ['echo'], allowedPaths: [process.cwd()], deniedPaths: ['/etc', '/proc', '/sys', '/dev'], environmentAllowlist: [], networkMode: 'none', timeoutMs: 5_000, memoryLimitMb: 128, cpuLimit: 1, maxProcesses: 4, readOnlyRoot: true, workspacePath: process.cwd(), containerImage: 'node:20-bookworm-slim', user: '1000:1000', allowNetwork: false, allowChildProcesses: false }, command: { command: 'echo', args: ['sandbox-ok'], cwd: '.', env: {} } } }); } catch (error) { sandboxStatus = error instanceof Error ? `denied: ${error.message}` : `denied: ${String(error)}`; }
    let intentionalFailure = 'not-triggered';
    try { await runtime.execute({ goal: 'Intentional bounded failure', budget: { maxTasks: 0 } }); } catch (error) { intentionalFailure = error instanceof Error ? error.message : String(error); await runtime.events.append({ type: 'execution.failed', payload: { reason: intentionalFailure, demo: true } }); }
    await runtime.recordLearningOutcome({ executionId: execution.id, taskId: execution.taskIds[0]!, taskType: 'control-plane-demo', agentId: firstAgent.id, capabilities: ['analysis'], success: true, quality: 0.92, executionTimeMs: execution.usage.runtimeMs, attempts: 1, output: 'operator evidence' });
    const goalA = await runtime.swarms.create({ name: 'control-observability', goalId: execution.id, topology: 'parallel', maxAgents: 8 });
    const goalB = await runtime.swarms.create({ name: 'control-recovery', goalId: execution.id, topology: 'hierarchical', maxAgents: 8 });
    await runtime.swarms.form(goalA.id, [{ id: 'm16-swarm-analysis', title: 'control-plane analysis', requiredCapabilities: ['analysis'], dependencies: [], parallelizable: true }]);
    await runtime.swarms.form(goalB.id, [{ id: 'm16-swarm-testing', title: 'control-plane testing', requiredCapabilities: ['testing'], dependencies: [], parallelizable: true }]);
    const extraNode = runtime.federation.registerNode({ id: 'm16-demo-worker', name: 'm16-demo-worker', endpoint: 'https://m16-demo-worker.invalid', role: 'worker', capabilities: ['analysis', 'testing'], trustLevel: 'TRUSTED' });
    runtime.federation.heartbeat(extraNode.id);
    const federationTask = runtime.federation.dispatch({ taskId: 'm16-demo-reassign', requiredCapabilities: ['analysis'], locality: 'local', nodeId: runtime.federation.localNodeId, securityContext: { subject: 'm16-demo', permissions: ['federation:dispatch'], trustLevel: 'ADMIN' }, authorizationContext: { subject: 'm16-demo' } });
    const reassigned = await runtime.federation.handoff((await federationTask).taskId, extraNode.id);
    const snapshot = await control.snapshot();
    const trace = await control.trace(execution.id);
    console.log(JSON.stringify({ demo: 'helix-control-plane-m16', agents: runtime.agents.list().length, swarms: [goalA, goalB].map((swarm) => ({ id: swarm.id, state: swarm.state, topology: swarm.topology })), executions: snapshot.executions.length, tasks: snapshot.tasks.length, workerPathExecution: { id: execution.id, status: execution.status }, sandbox: sandboxStatus, intentionalFailure, recovery: { reassignedTask: reassigned.taskId, nodeId: reassigned.nodeId, status: reassigned.status }, memory: snapshot.memory, metrics: snapshot.metrics, eventCount: control.events.size, trace: trace ? { executionId: trace.executionId, status: trace.status, stages: trace.stages.length, decisions: trace.decisions.length, errors: trace.errors.length } : undefined, provider: runtime.provider.name, externalCalls: false, limitations: ['the demo uses the deterministic provider and local sandbox; no external provider call was made', 'federation reassignment is local control-plane evidence, not cross-host consensus', 'M16 does not claim Byzantine fault tolerance'] }, null, 2));
  } finally { await sleep(100); await removeDirectory(directory).catch(() => undefined); }
}
void main();
