import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { HelixRuntime } from '../packages/runtime/src/index.js';
import { IntelligenceAgentSelector, IntelligencePlanner, IntelligenceReplanner, PlanValidator, analyzeGoal, createGoal, type PlanStep } from '../packages/intelligence/src/index.js';

function percentile(values: number[], p: number): number { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0; }
function summary(values: number[]): { p50: number; p95: number; p99: number; average: number } { return { p50: Number(percentile(values, 0.5).toFixed(4)), p95: Number(percentile(values, 0.95).toFixed(4)), p99: Number(percentile(values, 0.99).toFixed(4)), average: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) }; }

const directory = await mkdtemp(join(tmpdir(), 'helix-m12-benchmark-'));
try {
  const runtime = new HelixRuntime({ dataDirectory: directory, learningAsync: false });
  for (let index = runtime.agents.list().length; index < 100; index += 1) runtime.agents.register({ name: `benchmark-agent-${index}`, role: 'analysis worker', capabilities: ['analysis', 'testing', 'review'] });
  await runtime.init();
  const agents = runtime.agents.list();
  const goal = createGoal({ title: 'Analyze deterministic workload', description: 'Analyze a deterministic workload with 100 agents and 1000 task units', requiredCapabilities: ['analysis'] });
  const analysisStarted = performance.now();
  const analysis = analyzeGoal(goal);
  const analysisMs = performance.now() - analysisStarted;
  const planner = new IntelligencePlanner({ maxTasks: 64 });
  const planningStarted = performance.now();
  const plan = planner.create(goal, analysis);
  const planningMs = performance.now() - planningStarted;
  const validator = new PlanValidator();
  const validationStarted = performance.now();
  const validation = validator.validate(plan, goal, agents);
  const validationMs = performance.now() - validationStarted;
  const selector = new IntelligenceAgentSelector({ agents, router: runtime.router, learning: runtime.learning, subject: 'benchmark' });
  const task: PlanStep = { id: 'benchmark-task', title: 'Analyze benchmark task', description: 'Select an available analysis agent for a deterministic task unit', requiredCapabilities: ['analysis'], priority: 5, dependencies: [], estimatedComplexity: 'low', preferredAgentTypes: ['analyst'], parallelizable: true, maxRetries: 0, depth: 0 };
  for (let index = 0; index < 10; index += 1) await selector.select(task, analysis);
  const selectionLatencies: number[] = [];
  const memoryLatencies: number[] = [];
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage().heapUsed;
  const workloadStarted = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    const memoryStarted = performance.now();
    await runtime.searchMemory({ query: 'deterministic workload analysis', namespace: 'global', types: ['solution', 'pattern', 'failure', 'routing-hint'], limit: 8, context: { subject: 'benchmark' } });
    memoryLatencies.push(performance.now() - memoryStarted);
    const selectionStarted = performance.now();
    await selector.select(task, analysis);
    selectionLatencies.push(performance.now() - selectionStarted);
  }
  const workloadMs = performance.now() - workloadStarted;
  const replanner = new IntelligenceReplanner(runtime, selector);
  const replanStarted = performance.now();
  const replanDecision = await replanner.decide({ goal, analysis, plan, step: plan.steps[0]!, trigger: 'agent_failure', cause: 'measured deterministic failure', ...(agents[0] ? { failedAgentId: agents[0].id } : {}), subject: 'benchmark' });
  const replanningMs = performance.now() - replanStarted;
  const orchestration = runtime.createOrchestrator({ subject: 'benchmark' });
  const fullGoal = await orchestration.createGoal({ title: 'Document benchmark outcome', description: 'Write and review a concise benchmark outcome' });
  await orchestration.analyzeGoal(fullGoal);
  const fullPlan = await orchestration.createPlan(fullGoal);
  const executionStarted = performance.now();
  const fullRun = await orchestration.executePlan(fullPlan.id);
  const executionMs = performance.now() - executionStarted;
  const evaluationStarted = performance.now();
  const evaluation = await orchestration.evaluate(fullRun.id);
  const evaluationMs = performance.now() - evaluationStarted;
  await runtime.flushLearning();
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ benchmark: 'm12-intelligence', deterministic: true, agentCount: agents.length, taskUnits: 1_000, planSteps: plan.steps.length, planTopology: plan.recommendedTopology, planValid: validation.valid, stagesMs: { analysis: Number(analysisMs.toFixed(4)), planning: Number(planningMs.toFixed(4)), validation: Number(validationMs.toFixed(4)), execution: Number(executionMs.toFixed(4)), evaluation: Number(evaluationMs.toFixed(4)), replanning: Number(replanningMs.toFixed(4)) }, selection: summary(selectionLatencies), memoryLookup: summary(memoryLatencies), throughputTaskUnitsPerSecond: Number((1_000 / (workloadMs / 1_000)).toFixed(2)), replanAlternativeSelected: Boolean(replanDecision.alternativeAgentId), orchestration: { state: fullRun.state, evaluationScore: evaluation.score, replans: fullRun.replans.length, completedSteps: fullRun.steps.filter((step) => step.status === 'completed').length }, resources: { workloadMs: Number(workloadMs.toFixed(3)), heapDeltaMb: Number(((memoryAfter - memoryBefore) / 1_048_576).toFixed(3)), cpuUserMs: Number((cpu.user / 1_000).toFixed(3)), cpuSystemMs: Number((cpu.system / 1_000).toFixed(3)) } }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
