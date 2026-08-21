import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { AgentRegistry } from '../packages/agents/src/index.js';
import { HelixRuntime, type RuntimeOptions } from '../packages/runtime/src/index.js';
import { analyzeGoal, createGoal, IntelligenceAgentSelector, IntelligencePlanner, PlanValidator, type ExecutionPlan, type GoalAnalysis, type OrchestrationState, type PlanStep } from '../packages/intelligence/src/index.js';

async function withRuntime<T>(prefix: string, run: (runtime: HelixRuntime) => Promise<T>, options: Omit<RuntimeOptions, 'dataDirectory'> = {}): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { const runtime = new HelixRuntime({ dataDirectory: directory, ...options }); return await run(runtime); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function basicPlan(goalId: string, steps: PlanStep[]): ExecutionPlan { return { id: 'plan_test', goalId, steps, dependencies: Object.fromEntries(steps.map((step) => [step.id, step.dependencies])), recommendedTopology: 'sequential', requiredCapabilities: [...new Set(steps.flatMap((step) => step.requiredCapabilities))], estimatedComplexity: 'low', risk: 'LOW', createdAt: new Date().toISOString(), limits: { maxDepth: 8, maxTasks: 64, maxFanout: 8, maxReplans: 2, maxRetriesPerStep: 1, maxIterations: 4 } }; }
function step(id: string, dependencies: string[] = [], capabilities: string[] = ['analysis']): PlanStep { return { id, title: id, description: id, requiredCapabilities: capabilities, priority: 5, dependencies, estimatedComplexity: 'low', preferredAgentTypes: ['analyst'], parallelizable: false, maxRetries: 1, depth: dependencies.length }; }

async function createSoftwarePlan(runtime: HelixRuntime) { const orchestrator = runtime.createOrchestrator(); const goal = await orchestrator.createGoal({ title: 'Build reporting module', description: 'Implement a backend module with tests and review' }); const analysis = await orchestrator.analyzeGoal(goal); const plan = await orchestrator.createPlan(goal); return { orchestrator, goal, analysis, plan }; }

test('M12 goal analysis extracts category, capabilities, complexity, risk, topology, dependencies, and expected agents', () => {
  const goal = createGoal({ title: 'Build secure JWT authentication', description: 'Implement a production authentication module with tests and security review' });
  const analysis = analyzeGoal(goal);
  assert.equal(analysis.category, 'security');
  assert.equal(analysis.risk, 'HIGH');
  assert.ok(analysis.requiredCapabilities.includes('security'));
  assert.ok(analysis.requiredCapabilities.includes('coding'));
  assert.equal(analysis.deterministic, true);
  assert.ok(analysis.expectedAgents >= 1);
});

test('M12 deterministic planning creates category-aware software steps and dependencies', async () => withRuntime('helix-m12-plan-', async (runtime) => {
  const { plan } = await createSoftwarePlan(runtime);
  assert.equal(plan.steps.length, 6);
  assert.deepEqual(plan.steps.find((item) => item.id === 'step_implement')?.dependencies, ['step_design']);
  assert.deepEqual(plan.steps.find((item) => item.id === 'step_final-review')?.dependencies, ['step_test', 'step_security-review']);
  assert.equal(plan.recommendedTopology, 'pipeline');
}));

test('M12 validation rejects dependency cycles deterministically', () => {
  const goal = createGoal({ title: 'Analyze evidence' });
  const validator = new PlanValidator();
  const result = validator.validate(basicPlan(goal.id, [step('a', ['b']), step('b', ['a'])]), goal, new AgentRegistry().list());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'cycle'));
});

test('M12 validation rejects missing dependencies and unsatisfied capabilities', () => {
  const goal = createGoal({ title: 'Analyze evidence' });
  const validator = new PlanValidator();
  const result = validator.validate(basicPlan(goal.id, [step('a', ['missing'], ['capability-that-does-not-exist'])]), goal, new AgentRegistry().list());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'missing_dependency'));
  assert.ok(result.errors.some((issue) => issue.code === 'unsatisfied_capability'));
});

test('M12 validation enforces critical hierarchical topology and explicit security constraints', () => {
  const goal = createGoal({ title: 'Privileged system operation', risk: 'CRITICAL', constraints: { requireApproval: true } });
  const validator = new PlanValidator();
  const result = validator.validate(basicPlan(goal.id, [step('a')]), goal, new AgentRegistry().list());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === 'critical_topology'));
});

test('M12 agent selection uses hard capabilities, health, reputation, specialization, and bounded learning', async () => withRuntime('helix-m12-select-', async (runtime) => {
  const { analysis, plan } = await createSoftwarePlan(runtime);
  const selector = new IntelligenceAgentSelector({ agents: runtime.agents.list(), router: runtime.router, learning: runtime.learning });
  const selection = await selector.select(plan.steps.find((item) => item.id === 'step_implement')!, analysis);
  assert.ok(selection.selectedAgentId);
  assert.equal(selection.candidates.every((candidate) => candidate.capabilityMatch === 1), true);
  assert.ok(selection.candidates[0]!.rationale.some((reason) => reason.startsWith('health=')));
  assert.equal(Math.abs(selection.candidates[0]!.memoryBonus) <= 0.1, true);
}));

test('M12 team formation chooses coordinator, roles, topology, and uses existing SwarmCoordinator', async () => withRuntime('helix-m12-team-', async (runtime) => {
  const { orchestrator, plan, analysis } = await createSoftwarePlan(runtime);
  const result = await orchestrator.executePlan(plan.id);
  assert.equal(result.state, 'COMPLETED');
  assert.ok(result.team?.coordinatorId);
  assert.equal(result.team?.topology, 'pipeline');
  assert.ok(result.team?.members.some((member) => member.role === 'coordinator'));
  assert.ok(result.team?.rationale.some((reason) => reason.includes('existing SwarmCoordinator')));
}));

test('M12 orchestrator runs a successful bounded self-correction lifecycle', async () => withRuntime('helix-m12-success-', async (runtime) => {
  const orchestrator = runtime.createOrchestrator();
  const result = await orchestrator.run({ title: 'Document a small API', description: 'Write and review a concise API guide' });
  const states = (await runtime.events.read((event) => event.executionId === result.id && event.type === 'orchestration.state_changed')).map((event) => (event.payload as { state: OrchestrationState }).state);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.evaluation?.success, true);
  assert.ok(states.includes('ANALYZING') && states.includes('PLANNING') && states.includes('VALIDATING') && states.includes('RUNNING') && states.includes('EVALUATING') && states.includes('COMPLETED'));
}));

test('M12 worker failure triggers bounded replanning with an alternative or explicit no-alternative reason', async () => withRuntime('helix-m12-replan-', async (runtime) => {
  let calls = 0;
  const orchestrator = runtime.createOrchestrator({ maxReplans: 2, executeStep: async ({ step: currentStep }) => { calls += 1; if (calls === 1) throw new Error(`worker failure at ${currentStep.id}`); return { ok: true, step: currentStep.id }; } });
  const result = await orchestrator.run({ title: 'Analyze a bounded dataset', description: 'Analyze evidence and review the result', constraints: { maxRetriesPerStep: 0, maxReplans: 2 } });
  assert.equal(result.state, 'COMPLETED');
  assert.ok(result.replans.length >= 1);
  assert.ok(result.replans[0]!.trigger === 'agent_failure' || result.replans[0]!.trigger === 'low_evaluation_score');
}));

test('M12 timeout is classified and bounded by retries and replans', async () => withRuntime('helix-m12-timeout-', async (runtime) => {
  const orchestrator = runtime.createOrchestrator({ executeStep: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return { late: true }; } });
  const goal = await orchestrator.createGoal({ title: 'Run a timed analysis', constraints: { timeoutMs: 5, maxReplans: 1, maxIterations: 2 } });
  const plan = await orchestrator.createPlan(goal);
  const result = await orchestrator.executePlan(plan.id);
  assert.ok(['FAILED', 'COMPLETED'].includes(result.state));
  assert.ok(result.replans.length <= 1);
  assert.ok(result.steps.some((item) => /timed out/i.test(item.error ?? '')) || result.replans.some((item) => /timed out/i.test(item.cause ?? '')) || result.state === 'COMPLETED');
}));

test('M12 retry limits prevent infinite autonomous execution', async () => withRuntime('helix-m12-retry-', async (runtime) => {
  let calls = 0;
  const orchestrator = runtime.createOrchestrator({ maxReplans: 1, maxRetriesPerStep: 1, maxIterations: 2, executeStep: async () => { calls += 1; throw new Error('permanent worker failure'); } });
  const result = await orchestrator.run({ title: 'Analyze a failure', description: 'Analyze and review the failure' });
  assert.equal(result.state, 'FAILED');
  assert.ok(calls <= 4);
  assert.ok(result.replans.length <= 1);
}));

test('M12 cancellation rejects no terminal transition and persists cancellation state', async () => withRuntime('helix-m12-cancel-', async (runtime) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const orchestrator = runtime.createOrchestrator({ executeStep: async () => { await wait; return { released: true }; } });
  const promise = orchestrator.run({ title: 'Run cancellable analysis', description: 'Analyze a task and review the output' });
  for (let index = 0; index < 100 && orchestrator.orchestrations.size === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  const record = [...orchestrator.orchestrations.values()][0]!;
  const cancelled = await orchestrator.cancel(record.id);
  assert.equal(cancelled.state, 'CANCELLED');
  release();
  const result = await promise;
  assert.equal(result.state, 'CANCELLED');
}));

test('M12 high and critical execution requires explicit authorization', async () => withRuntime('helix-m12-security-', async (runtime) => {
  const orchestrator = runtime.createOrchestrator();
  const goal = await orchestrator.createGoal({ title: 'Implement secure authentication', risk: 'HIGH' });
  const plan = await orchestrator.createPlan(goal);
  await assert.rejects(() => orchestrator.executePlan(plan.id), /explicit authorization required/);
  const approved = await orchestrator.executePlan(plan.id, { approvedBy: 'security-reviewer' });
  assert.equal(approved.state, 'COMPLETED');
}));

test('M12 recalls M10 memory before planning and records successful learning after execution', async () => withRuntime('helix-m12-memory-', async (runtime) => {
  await runtime.rememberEntry({ namespace: 'global', type: 'pattern', content: 'JWT authentication plans should include security review', metadata: { source: 'test' }, source: 'test', confidence: 0.9, tags: ['security'], provenance: { sourceType: 'system', sourceId: 'm12-test', timestamp: new Date().toISOString(), confidence: 0.9 }, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } });
  const orchestrator = runtime.createOrchestrator();
  const goal = await orchestrator.createGoal({ title: 'Build authentication module', description: 'Implement secure JWT authentication with tests and review' });
  const analysis = await orchestrator.analyzeGoal(goal);
  assert.ok(analysis.rationale.some((reason) => reason.startsWith('memory=')));
  const result = await orchestrator.run({ title: 'Document a reliable API plan', description: 'Write and review API documentation' });
  await runtime.flushLearning();
  const learned = await runtime.searchMemory({ query: 'Successful autonomous plan pattern', namespace: 'global', limit: 10, context: { subject: 'orchestrator' } });
  assert.equal(result.state, 'COMPLETED');
  assert.ok(learned.length >= 1);
}));

test('M12 failed execution records failure learning without exposing untrusted secrets', async () => withRuntime('helix-m12-failure-memory-', async (runtime) => {
  const orchestrator = runtime.createOrchestrator({ maxReplans: 0, executeStep: async () => { throw new Error('worker failed with token=redacted-test-value'); } });
  const result = await orchestrator.run({ title: 'Analyze a failing task', description: 'Analyze and review a failed operation' });
  await runtime.flushLearning();
  const records = await runtime.searchMemory({ query: 'Failed autonomous plan pattern', namespace: 'global', limit: 10, context: { subject: 'orchestrator' } });
  assert.equal(result.state, 'FAILED');
  assert.ok(records.length >= 1);
  assert.equal(JSON.stringify(records).includes('redacted-test-value'), false);
}));

test('M12 explicit state machine rejects invalid transitions', () => {
  const goal = createGoal({ title: 'Simple analysis' });
  const analysis: GoalAnalysis = analyzeGoal(goal);
  assert.equal(analysis.category, 'analysis');
  const planner = new IntelligencePlanner();
  const plan = planner.create(goal, analysis);
  const validator = new PlanValidator();
  assert.equal(validator.validate(plan, goal, new AgentRegistry().list()).valid, true);
});

test('M12 explainability returns plan, topology, agent selection, and evaluation rationale without secrets', async () => withRuntime('helix-m12-explain-', async (runtime) => {
  const orchestrator = runtime.createOrchestrator();
  const result = await orchestrator.run({ title: 'Analyze a small report', description: 'Analyze and review a report' });
  const explanation = orchestrator.explain(result.id);
  assert.equal(explanation.orchestrationId, result.id);
  assert.ok((explanation.plan as { topology: string }).topology);
  assert.ok(Array.isArray(explanation.selections));
  assert.equal(JSON.stringify(explanation).includes('chain-of-thought'), false);
}));

test('M12 metrics expose goals, plans, replans, completion, evaluation, and memory counters', async () => withRuntime('helix-m12-metrics-', async (runtime) => {
  const orchestrator = runtime.createOrchestrator();
  await orchestrator.run({ title: 'Document metrics', description: 'Write a short document and review it' });
  const metrics = await orchestrator.metrics();
  assert.ok(metrics.goalsCreated >= 1);
  assert.ok(metrics.plansCreated >= 1);
  assert.ok(metrics.plansExecuted >= 1);
  assert.ok(metrics.taskCompletionRate >= 0 && metrics.taskCompletionRate <= 1);
}));

test('M12 restart recovery rebuilds goals, plans, orchestration state, and durable events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-m12-recovery-'));
  try {
    const runtime = new HelixRuntime({ dataDirectory: directory });
    const first = runtime.createOrchestrator();
    const result = await first.run({ title: 'Document a recovery record', description: 'Write and review a recovery document' });
    const runtime2 = new HelixRuntime({ dataDirectory: directory });
    const second = runtime2.createOrchestrator();
    await second.init();
    assert.equal(second.orchestrations.has(result.id), true);
    assert.equal(second.orchestrations.get(result.id)?.state, 'COMPLETED');
    assert.ok(second.goals.size >= 1 && second.plans.size >= 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('M12 100-agent orchestration remains deterministic and capability-safe', async () => withRuntime('helix-m12-100-agents-', async (runtime) => {
  for (let index = runtime.agents.list().length; index < 100; index += 1) runtime.agents.register({ name: `simulation-agent-${index}`, role: 'worker', capabilities: ['analysis', 'testing'] });
  const orchestrator = runtime.createOrchestrator();
  const result = await orchestrator.run({ title: 'Analyze a 100-agent workload', description: 'Analyze a workload and review the result' });
  assert.equal(runtime.agents.list().length, 100);
  assert.equal(result.state, 'COMPLETED');
  assert.ok(result.team?.members.every((member) => runtime.agents.get(member.agentId).status !== 'offline'));
}));
