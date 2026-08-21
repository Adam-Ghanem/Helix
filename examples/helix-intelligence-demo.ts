import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HelixRuntime } from '../packages/runtime/src/index.js';

const directory = await mkdtemp(join(tmpdir(), 'helix-m12-demo-'));
try {
  const runtime = new HelixRuntime({ dataDirectory: directory });
  for (let index = runtime.agents.list().length; index < 100; index += 1) runtime.agents.register({ name: `demo-agent-${index}`, role: 'autonomous worker', capabilities: ['analysis', 'coding', 'testing', 'security', 'review', 'documentation', 'research', 'operations'] });
  const forcedFailures = new Set<string>();
  const orchestrator = runtime.createOrchestrator({ subject: 'demo-user', maxReplans: 2, maxRetriesPerStep: 0, executeStep: async ({ step, attempt, agentId }) => {
    if (step.id === 'step_implement' && attempt === 1 && !forcedFailures.has(step.id)) { forcedFailures.add(step.id); throw new Error('forced demo worker failure for bounded replanning'); }
    return { summary: `${step.title} completed by ${agentId}`, evidence: ['deterministic demo execution'] };
  } });
  const softwareGoal = await orchestrator.createGoal({ title: 'Build a reliable reporting module', description: 'Implement a reporting module with tests and a concise delivery summary', constraints: { maxRetriesPerStep: 0, maxReplans: 2 }, expectedOutcome: 'A validated reporting module plan and evidence-backed completion' });
  const softwareAnalysis = await orchestrator.analyzeGoal(softwareGoal);
  const softwarePlan = await orchestrator.createPlan(softwareGoal);
  const softwareValidation = await orchestrator.validatePlan(softwarePlan);
  const softwareResult = await orchestrator.executePlan(softwarePlan.id);
  const secureResult = await orchestrator.run({ title: 'Audit security permissions', description: 'Review authorization boundaries and produce a security evidence summary' }, { approvedBy: 'demo-operator' });
  const parallelGoal = await orchestrator.createGoal({ title: 'Analyze many independent evidence batches', description: 'Analyze many independent evidence batches and review the resulting findings', constraints: { requiredTopology: 'parallel' }, requiredCapabilities: ['analysis', 'review'] });
  const parallelAnalysis = await orchestrator.analyzeGoal(parallelGoal);
  const parallelPlan = await orchestrator.createPlan(parallelGoal);
  const parallelValidation = await orchestrator.validatePlan(parallelPlan);
  await runtime.flushLearning();
  const explanation = orchestrator.explain(softwareResult.id);
  const metrics = await orchestrator.metrics();
  console.log(JSON.stringify({ agents: runtime.agents.list().length, goals: [{ id: softwareGoal.id, category: softwareAnalysis.category, topology: softwareAnalysis.likelyTopology, risk: softwareAnalysis.risk }, { id: parallelGoal.id, category: parallelAnalysis.category, topology: parallelAnalysis.likelyTopology, risk: parallelAnalysis.risk }], forcedFailure: { stepId: 'step_implement', replans: softwareResult.replans.length, alternatives: softwareResult.replans.map((replan) => replan.alternativeAgentId ?? 'none') }, plans: [{ id: softwarePlan.id, steps: softwarePlan.steps.length, valid: softwareValidation.valid, topology: softwarePlan.recommendedTopology }, { id: parallelPlan.id, steps: parallelPlan.steps.length, valid: parallelValidation.valid, topology: parallelPlan.recommendedTopology }], executions: [{ id: softwareResult.id, state: softwareResult.state, score: softwareResult.evaluation?.score ?? 0 }, { id: secureResult.id, state: secureResult.state, score: secureResult.evaluation?.score ?? 0, authorization: 'demo-operator' }], learning: metrics, explanation: { selections: Array.isArray(explanation.selections) ? explanation.selections.length : 0, team: explanation.team, events: (await runtime.events.read((event) => event.executionId === softwareResult.id)).length } }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
