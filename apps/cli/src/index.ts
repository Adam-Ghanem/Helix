#!/usr/bin/env node
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HelixRuntime, HttpModelProvider } from '../../../packages/runtime/src/index.js';
import { defaultSandboxPolicy, dockerAvailable } from '../../../packages/sandbox/src/index.js';
import { HelixMcpServer, MCP_TOOL_FAMILY_COUNTS } from '../../../packages/mcp/src/index.js';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const dataDirectory = process.env.HELIX_DATA_DIR ?? join(process.cwd(), '.helix');
const modelProvider = process.env.HELIX_MODEL_API_URL && process.env.HELIX_MODEL_API_KEY && process.env.HELIX_MODEL
  ? new HttpModelProvider({ endpoint: process.env.HELIX_MODEL_API_URL, apiKey: process.env.HELIX_MODEL_API_KEY, model: process.env.HELIX_MODEL })
  : undefined;
const runtime = new HelixRuntime({ dataDirectory, ...(modelProvider ? { provider: modelProvider } : {}) });

function print(value: unknown): void {
  if (jsonOutput) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}
function option(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }

function help(): void {
  console.log(`HELIX — Coordinate Intelligence\n\nUsage:\n  helix run <goal> [--json]\n  helix agents [--json]\n  helix events [--json]\n  helix execution <id> <pause|resume|cancel|retry|checkpoint> [--json]\n  helix approvals [list|approve|deny] [id] [--json]\n  helix sandbox doctor [--json]\n  helix sandbox run [--docker] [--network none] [--memory MB] [--timeout 10s] -- <command> [args...]\n  helix sandbox status [--json]\n  helix sandbox destroy <id> [--json]
  helix memory search "<query>" [--json]
  helix memory list [--json]
  helix memory inspect <id> [--json]
  helix memory stats [--json]
  helix memory compact [--vacuum] [--expired] [--json]
  helix learning agent <agentId> [--json]
  helix learning flush [--json]
  helix learning hints "<task>" [--json]
  helix goal create "<title>" [--description "..."] [--json]
  helix goal analyze <goalId> [--json]
  helix plan create <goalId> [--json]
  helix plan validate <planId> [--json]
  helix plan show <planId> [--json]
  helix orchestrate --title "..." --description "..." [--approved-by <actor>] [--json]
  helix orchestrate status <orchestrationId> [--json]
  helix orchestrate cancel <orchestrationId> [--json]
  helix swarm create --goal "..." [--topology adaptive] [--max-agents 12] [--json]
  helix swarm status <swarmId> [--json]
  helix swarm members <swarmId> [--json]
  helix swarm scale <swarmId> <count> [--json]
  helix swarm rebalance <swarmId> [--json]
  helix swarm delegate <swarmId> <taskId> <capability> [--target <agent|ROLE|swarm>] [--json]
  helix swarm handoff <swarmId> <taskId> <fromAgentId> <toAgentId> --reason "..." [--json]
  helix swarm graph <swarmId> [--json]
  helix swarm consensus <swarmId> [--json]
  helix swarm explain <swarmId> [--json]
  helix mcp serve [--json]
  helix mcp doctor [--json]
  helix mcp tools [--json]
  helix mcp resources [--json]
  helix mcp prompts [--json]
  helix verify [--json]\n  helix recover [--json]\n  helix benchmark [--agents N] [--json]`);
}

async function main(): Promise<void> {
  await runtime.init();
  const command = args[0];
  if (!command || command === '--help' || command === 'help') return help();
  if (command === 'run') {
    const goal = args.filter((arg, index) => index > 0 && arg !== '--json').join(' ').trim();
    if (!goal) throw new Error('A goal is required. Example: helix run "Analyze this repository"');
    const execution = await runtime.execute({ goal });
    if (jsonOutput) return print(execution);
    console.log('HELIX');
    console.log('──────────────────────────────────────');
    console.log(`Execution: ${execution.id}`);
    console.log(`Status:    ${execution.status}`);
    console.log(`Tasks:     ${execution.usage.tasks}`);
    console.log(`Completed: ${execution.result && typeof execution.result === 'object' ? (execution.result as { completedTasks?: number }).completedTasks ?? 0 : 0}`);
    console.log(`Cost:      $${execution.usage.costUsd.toFixed(4)}`);
    console.log(`Tokens:    ${execution.usage.tokens}`);
    return;
  }
  if (command === 'agents') return print({ agents: runtime.agents.list() });
  if (command === 'events') return print({ events: await runtime.events.read() });
  if (command === 'execution') {
    const executionId = args[1];
    const action = args[2];
    if (!executionId || !['pause', 'resume', 'cancel', 'retry', 'checkpoint'].includes(action ?? '')) throw new Error('Usage: helix execution <id> <pause|resume|cancel|retry|checkpoint>');
    if (action === 'pause') return print(await runtime.pause(executionId));
    if (action === 'resume') return print(await runtime.resume(executionId));
    if (action === 'cancel') return print(await runtime.cancel(executionId));
    if (action === 'retry') return print(await runtime.retry(executionId));
    return print(await runtime.checkpoint(executionId));
  }
  if (command === 'approvals') {
    const action = args[1] ?? 'list';
    const approvalId = args[2];
    if (action === 'list') return print({ approvals: runtime.policy.listApprovals() });
    if (!approvalId || !['approve', 'deny'].includes(action)) throw new Error('Usage: helix approvals <list|approve|deny> [id]');
    const approval = action === 'approve' ? runtime.policy.approve(approvalId, 'cli-user') : runtime.policy.deny(approvalId, 'cli-user');
    await runtime.events.append({ type: `approval.${approval.status}`, executionId: approval.executionId, agentId: approval.requestedBy, payload: approval });
    return print(approval);
  }
  if (command === 'memory') {
    const action = args[1];
    const context = { subject: process.env.HELIX_SUBJECT ?? 'cli-user' };
    if (action === 'search') { const query = args.slice(2).filter((arg) => arg !== '--json').join(' ').trim(); if (!query) throw new Error('Usage: helix memory search "<query>"'); return print(await runtime.searchMemory({ query, limit: 20, context })); }
    if (action === 'list') return print(await runtime.memory.listEntries(context));
    if (action === 'inspect') { if (!args[2]) throw new Error('Usage: helix memory inspect <id>'); return print(await runtime.getMemory(args[2], context)); }
    if (action === 'stats') return print({ stats: await runtime.memoryStats(context), cacheEntries: runtime.memoryCacheSize(), backend: runtime.memory.constructor.name });
    if (action === 'compact') return print({ result: await runtime.compactMemory({ mergePatterns: true, removeExpiredLegacy: args.includes('--expired'), vacuum: args.includes('--vacuum') }), cacheEntries: runtime.memoryCacheSize() });
    throw new Error('Usage: helix memory <search|list|inspect|stats|compact>');
  }
  if (command === 'learning') {
    const action = args[1];
    if (action === 'agent') { if (!args[2]) throw new Error('Usage: helix learning agent <agentId>'); return print(await runtime.agentExperience(args[2])); }
    if (action === 'hints') { const task = args.slice(2).filter((arg) => arg !== '--json').join(' ').trim(); if (!task) throw new Error('Usage: helix learning hints "<task>"'); return print(await runtime.learningHints(task, ['analysis'], { subject: process.env.HELIX_SUBJECT ?? 'cli-user' })); }
    if (action === 'flush') { await runtime.flushLearning(); return print({ pendingWrites: runtime.learning.pendingWrites }); }
    throw new Error('Usage: helix learning <agent|hints|flush>');
  }
  if (command === 'goal') {
    const orchestrator = runtime.createOrchestrator({ subject: process.env.HELIX_SUBJECT ?? 'cli-user' });
    const action = args[1];
    if (action === 'create') { const title = args.slice(2).filter((arg, index) => arg !== '--description' && arg !== '--json' && !args.slice(2, index + 2).includes('--description')).join(' ').trim(); const descriptionIndex = args.indexOf('--description'); const description = descriptionIndex >= 0 ? args[descriptionIndex + 1] : undefined; if (!title) throw new Error('Usage: helix goal create "<title>" [--description "..."]'); return print(await orchestrator.createGoal({ title, ...(typeof description === 'string' ? { description } : {}) })); }
    if (action === 'analyze') { if (!args[2]) throw new Error('Usage: helix goal analyze <goalId>'); return print(await orchestrator.analyzeGoal(args[2])); }
    throw new Error('Usage: helix goal <create|analyze>');
  }
  if (command === 'plan') {
    const orchestrator = runtime.createOrchestrator({ subject: process.env.HELIX_SUBJECT ?? 'cli-user' }); const action = args[1]; const idValue = args[2];
    if (!idValue || !['create', 'validate', 'show'].includes(action ?? '')) throw new Error('Usage: helix plan <create|validate|show> <id>');
    if (action === 'create') return print(await orchestrator.createPlan(idValue));
    if (action === 'validate') return print(await orchestrator.validatePlan(idValue));
    const plan = orchestrator.plans.get(idValue); if (!plan) throw new Error(`Unknown plan: ${idValue}`); return print(plan);
  }
  if (command === 'orchestrate') {
    const orchestrator = runtime.createOrchestrator({ subject: process.env.HELIX_SUBJECT ?? 'cli-user' }); const action = args[1];
    if (action === 'status' || action === 'cancel') { const orchestrationId = args[2]; if (!orchestrationId) throw new Error(`Usage: helix orchestrate ${action} <orchestrationId>`); return print(action === 'status' ? await orchestrator.status(orchestrationId) : await orchestrator.cancel(orchestrationId)); }
    const titleIndex = args.indexOf('--title'); const descriptionIndex = args.indexOf('--description'); const approvalIndex = args.indexOf('--approved-by'); const title = titleIndex >= 0 ? args[titleIndex + 1] : args.slice(1).filter((arg) => !arg.startsWith('--')).join(' '); const description = descriptionIndex >= 0 ? args[descriptionIndex + 1] : title; const approvedBy = approvalIndex >= 0 ? args[approvalIndex + 1] : undefined; if (!title) throw new Error('Usage: helix orchestrate --title "..." --description "..."'); return print(await orchestrator.run({ title, ...(typeof description === 'string' ? { description } : {}) }, typeof approvedBy === 'string' ? { approvedBy } : undefined));
  }
  if (command === 'swarm') {
    const orchestrator = runtime.createOrchestrator({ subject: process.env.HELIX_SUBJECT ?? 'cli-user' });
    const action = args[1];
    if (action === 'create') { const goalText = option('--goal') ?? args.slice(2).filter((arg) => !arg.startsWith('--')).join(' ').trim(); if (!goalText) throw new Error('Usage: helix swarm create --goal "..."'); const goal = await orchestrator.createGoal({ title: option('--name') ?? goalText.slice(0, 80), description: goalText }); const swarm = await orchestrator.createSwarm({ name: option('--name') ?? 'helix-cli-swarm', goalId: goal.id, ...(option('--topology') ? { topology: option('--topology') as import('../../../packages/swarm/src/index.js').DynamicSwarmTopology } : {}), ...(option('--max-agents') ? { maxAgents: Number(option('--max-agents')) } : {}) }); return print({ goal, swarm }); }
    const swarmId = args[2]; if (!swarmId) throw new Error('Usage: helix swarm <status|members|scale|rebalance|delegate|handoff|graph|consensus|explain> <swarmId>');
    if (action === 'status') return print(orchestrator.swarmStatus(swarmId));
    if (action === 'members') return print({ swarmId, members: orchestrator.swarmStatus(swarmId).members });
    if (action === 'scale') { const count = Number(args[3]); if (!Number.isInteger(count)) throw new Error('Usage: helix swarm scale <swarmId> <count>'); return print(await orchestrator.scaleSwarm(swarmId, count)); }
    if (action === 'rebalance') return print(await orchestrator.rebalanceSwarm(swarmId, option('--reason')));
    if (action === 'delegate') { const taskId = args[3]; const capability = args[4]; if (!taskId || !capability) throw new Error('Usage: helix swarm delegate <swarmId> <taskId> <capability>'); return print(await orchestrator.delegateToSwarm(swarmId, { id: taskId, title: taskId, requiredCapabilities: [capability], dependencies: [], parallelizable: true }, option('--target') as import('../../../packages/core/src/index.js').AgentId | import('../../../packages/swarm/src/index.js').SwarmRole | 'swarm' ?? 'swarm')); }
    if (action === 'handoff') { const taskId = args[3]; const fromAgentId = args[4]; const toAgentId = args[5]; const reason = option('--reason'); if (!taskId || !fromAgentId || !toAgentId || !reason) throw new Error('Usage: helix swarm handoff <swarmId> <taskId> <fromAgentId> <toAgentId> --reason "..."'); return print(await orchestrator.handoffInSwarm(swarmId, taskId, fromAgentId, toAgentId, reason)); }
    if (action === 'graph') return print(orchestrator.swarmCollaboration(swarmId));
    if (action === 'consensus') return print({ swarmId, message: 'Provide votes through the SDK or governed MCP surface.' });
    if (action === 'explain') return print(orchestrator.explainSwarm(swarmId));
    throw new Error('Usage: helix swarm <create|status|members|scale|rebalance|delegate|handoff|graph|consensus|explain>');
  }
  if (command === 'mcp') {
    const mcp = new HelixMcpServer(runtime, { actorRoles: { 'mcp-user': 'viewer', 'mcp-operator': 'operator', 'mcp-admin': 'admin' } });
    const action = args[1] ?? 'doctor';
    if (action === 'tools') return print({ count: mcp.registry.count(), tools: await mcp.listTools(), familyCounts: MCP_TOOL_FAMILY_COUNTS });
    if (action === 'resources') return print({ resources: mcp.resources });
    if (action === 'prompts') return print({ prompts: mcp.prompts });
    if (action === 'doctor') return print({ server: 'helix-m13', sdk: 'official @modelcontextprotocol/sdk', tools: mcp.registry.count(), resources: mcp.resources.length, prompts: mcp.prompts.length, transports: ['stdio', 'streamable-http'], familyCounts: MCP_TOOL_FAMILY_COUNTS });
    if (action === 'serve') return mcp.connectStdio();
    throw new Error('Usage: helix mcp <serve|doctor|tools|resources|prompts>');
  }
  if (command === 'sandbox') {
    const action = args[1];
    if (action === 'doctor') return print({ local: { available: true, networkDefault: 'none', isolation: 'best-effort' }, docker: { available: await dockerAvailable(), requiredFlags: ['--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit', '--memory', '--cpus', '--network none'] } });
    if (action === 'status') return print({ sandboxes: runtime.sandbox.list() });
    if (action === 'destroy') { if (!args[2]) throw new Error('Usage: helix sandbox destroy <id>'); return print(await runtime.sandbox.destroy(args[2])); }
    if (action === 'run') {
      const separator = args.indexOf('--');
      if (separator < 0 || !args[separator + 1]) throw new Error('Usage: helix sandbox run [options] -- <command> [args...]');
      const commandName = args[separator + 1]!;
      const commandArgs = args.slice(separator + 2);
      const workspace = process.env.HELIX_SANDBOX_WORKSPACE ?? process.cwd();
      const timeoutText = args[args.indexOf('--timeout') + 1] ?? '30s';
      const timeoutMatch = timeoutText.match(/^(\d+)(ms|s|m)$/);
      if (!timeoutMatch) throw new Error('--timeout must use ms, s, or m');
      const timeoutUnits = Number(timeoutMatch[1]);
      const timeoutMs = timeoutMatch[2] === 'm' ? timeoutUnits * 60_000 : timeoutMatch[2] === 's' ? timeoutUnits * 1_000 : timeoutUnits;
      const network = args[args.indexOf('--network') + 1] ?? 'none';
      if (!['none', 'host', 'bridge', 'custom'].includes(network)) throw new Error('--network must be none, host, bridge, or custom');
      const memoryLimitMb = Number(args[args.indexOf('--memory') + 1] ?? 512);
      if (!Number.isFinite(memoryLimitMb) || memoryLimitMb <= 0) throw new Error('--memory must be positive');
      const sandboxPolicy = { ...defaultSandboxPolicy(workspace), allowedExecutables: [commandName], timeoutMs, memoryLimitMb, networkMode: network as 'none' | 'host' | 'bridge' | 'custom', allowNetwork: network !== 'none' };
      const created = await runtime.sandbox.create({ policy: sandboxPolicy, backend: args.includes('--docker') ? 'docker' : 'local' });
      try { await runtime.sandbox.start(created.sandboxId); return print(await runtime.sandbox.exec(created.sandboxId, { command: commandName, args: commandArgs, cwd: '.', env: {} })); }
      finally { await runtime.sandbox.destroy(created.sandboxId); }
    }
    throw new Error('Usage: helix sandbox <doctor|run|status|destroy>');
  }
  if (command === 'verify') return print({ ok: true, sequence: runtime.events.lastSequence, provider: runtime.provider.name, dataDirectory });
  if (command === 'recover') return print({ recovered: await runtime.recover(), sequence: runtime.events.lastSequence });
  if (command === 'benchmark') {
    const count = Number(args[args.indexOf('--agents') + 1] ?? 10);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('--agents must be an integer from 1 to 100');
    const started = performance.now();
    const execution = await runtime.execute({ goal: `Benchmark bounded swarm with ${count} agents`, budget: { maxAgents: count, maxTasks: 64 } });
    return print({ agents: count, executionId: execution.id, status: execution.status, elapsedMs: Math.round(performance.now() - started), tasks: execution.usage.tasks });
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(`helix: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
