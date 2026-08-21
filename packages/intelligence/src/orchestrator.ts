import { id, timestamp, type AgentId, type ExecutionId, type TaskRecord } from '../../core/src/index.js';
import { SwarmCoordinator, type SwarmTopology } from '../../swarm/src/index.js';
import type { HelixRuntime } from '../../runtime/src/index.js';
import { IntelligenceAgentSelector } from './agent-selector.js';
import { analyzeGoal, createGoal } from './goal.js';
import { OrchestrationEvaluator } from './evaluator.js';
import { IntelligencePlanner } from './planner.js';
import { PlanValidator } from './plan-validator.js';
import { IntelligenceReplanner } from './replanner.js';
import { classifyTask } from './task-classifier.js';
import type { Goal, GoalAnalysis, ExecutionPlan, PlanValidationResult, OrchestrationRecord, OrchestratorMetrics, OrchestratorOptions, OrchestrationState, PlanStep, ReplanDecision, ReplanTrigger, StepExecutionRecord, SwarmTeam } from './types.js';

const transitions: Record<OrchestrationState, OrchestrationState[]> = {
  CREATED: ['ANALYZING', 'CANCELLED'],
  ANALYZING: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['VALIDATING', 'FAILED', 'CANCELLED'],
  VALIDATING: ['READY', 'FAILED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['EVALUATING', 'REPLANNING', 'FAILED', 'CANCELLED'],
  EVALUATING: ['COMPLETED', 'REPLANNING', 'FAILED', 'CANCELLED'],
  REPLANNING: ['RUNNING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['REPLANNING', 'CANCELLED'],
  CANCELLED: [],
};

function clone<T>(value: T): T { return structuredClone(value); }
function safeSummary(value: unknown): string { return JSON.stringify(value).replace(/(sk-[A-Za-z0-9]{12,}|bearer\s+[A-Za-z0-9._-]+|password\s*[:=]\s*[^\s,]+|token\s*[:=]\s*[^\s,]+)/gi, '[REDACTED]').slice(0, 2_000); }
function timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`step timed out after ${timeoutMs}ms`)), timeoutMs); promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); }); }
function riskNeedsApproval(risk: Goal['risk'], options: OrchestratorOptions): boolean { return risk === 'HIGH' || risk === 'CRITICAL' || options.approvalRequiredFor?.includes(risk) === true; }
function swarmTopology(topology: ExecutionPlan['recommendedTopology']): SwarmTopology { if (topology === 'sequential') return 'pipeline'; if (topology === 'parallel') return 'ensemble'; return topology as SwarmTopology; }

export class HelixOrchestrator {
  readonly goals = new Map<string, Goal>();
  readonly analyses = new Map<string, GoalAnalysis>();
  readonly plans = new Map<string, ExecutionPlan>();
  readonly orchestrations = new Map<string, OrchestrationRecord>();
  private readonly approved = new Map<string, string>();
  private readonly planner: IntelligencePlanner;
  private readonly validator = new PlanValidator();
  private readonly evaluator = new OrchestrationEvaluator();
  private initialized = false;
  private readonly options: OrchestratorOptions;
  private readonly metricsState: OrchestratorMetrics = { goalsCreated: 0, goalsAnalyzed: 0, plansCreated: 0, plansRejected: 0, plansExecuted: 0, successfulPlans: 0, failedPlans: 0, replans: 0, averagePlanDurationMs: 0, averageExecutionDurationMs: 0, agentSelectionChanges: 0, taskCompletionRate: 0, evaluationScore: 0, memoryHits: 0, memoryMisses: 0 };

  constructor(private readonly runtime: HelixRuntime, options: OrchestratorOptions = {}) { this.options = { ...options }; const plannerOptions: Partial<typeof import('./planner.js').DEFAULT_INTELLIGENCE_LIMITS> = {}; if (options.maxReplans !== undefined) plannerOptions.maxReplans = options.maxReplans; if (options.maxRetriesPerStep !== undefined) plannerOptions.maxRetriesPerStep = options.maxRetriesPerStep; if (options.maxIterations !== undefined) plannerOptions.maxIterations = options.maxIterations; this.planner = new IntelligencePlanner(plannerOptions); }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.runtime.init();
    for (const event of await this.runtime.events.read()) this.rebuild(event.type, event.payload as Record<string, unknown>, event.executionId);
    this.initialized = true;
  }

  async createGoal(input: Parameters<typeof createGoal>[0]): Promise<Goal> {
    await this.init();
    const goal = createGoal(input); this.goals.set(goal.id, clone(goal)); this.metricsState.goalsCreated += 1;
    await this.runtime.events.append({ type: 'goal.created', payload: { goal }, idempotencyKey: `goal:${goal.id}:created` });
    return clone(goal);
  }

  async analyzeGoal(goalOrId: Goal | string): Promise<GoalAnalysis> {
    await this.init();
    const goal = typeof goalOrId === 'string' ? this.requireGoal(goalOrId) : goalOrId;
    const analysis = analyzeGoal(goal);
    const recalled = await this.runtime.searchMemory({ query: `${goal.title} ${goal.description}`, namespace: 'global', types: ['solution', 'pattern', 'failure', 'routing-hint'], limit: 8, context: { subject: this.options.subject ?? 'orchestrator' } });
    if (recalled.length) this.metricsState.memoryHits += 1; else this.metricsState.memoryMisses += 1;
    const enriched = { ...analysis, rationale: [...analysis.rationale, `memoryRecall=${recalled.length}`, ...recalled.slice(0, 3).map((entry) => `memory=${entry.entry.id}:${entry.entry.type}`)] };
    this.goals.set(goal.id, clone(goal)); this.analyses.set(goal.id, clone(enriched)); this.metricsState.goalsAnalyzed += 1;
    await this.runtime.events.append({ type: 'goal.analyzed', payload: { goalId: goal.id, analysis: enriched } });
    return clone(enriched);
  }

  async createPlan(goalOrId: Goal | string): Promise<ExecutionPlan> {
    await this.init();
    const goal = typeof goalOrId === 'string' ? this.requireGoal(goalOrId) : goalOrId;
    const analysis = this.analyses.get(goal.id) ?? await this.analyzeGoal(goal);
    const plan = this.planner.create(goal, analysis);
    this.goals.set(goal.id, clone(goal)); this.plans.set(plan.id, clone(plan)); this.metricsState.plansCreated += 1;
    await this.runtime.events.append({ type: 'plan.created', payload: { plan }, idempotencyKey: `plan:${plan.id}:created` });
    return clone(plan);
  }

  async validatePlan(planOrId: ExecutionPlan | string): Promise<PlanValidationResult> {
    await this.init();
    const plan = typeof planOrId === 'string' ? this.requirePlan(planOrId) : planOrId;
    const goal = this.requireGoal(plan.goalId); const validation = this.validator.validate(plan, goal, this.runtime.agents.list());
    if (!validation.valid) this.metricsState.plansRejected += 1;
    await this.runtime.events.append({ type: validation.valid ? 'plan.validated' : 'plan.rejected', payload: { planId: plan.id, validation } });
    return clone(validation);
  }

  async authorize(planOrId: string, approvedBy: string): Promise<{ planId: string; approvedBy: string; approvedAt: string }> {
    await this.init(); const plan = this.requirePlan(planOrId); const goal = this.requireGoal(plan.goalId);
    if (goal.risk !== 'HIGH' && goal.risk !== 'CRITICAL') throw new Error('explicit authorization is only required for high or critical plans');
    const approval = { planId: plan.id, approvedBy, approvedAt: timestamp() }; this.approved.set(plan.id, approvedBy); await this.runtime.events.append({ type: 'plan.approved', payload: approval }); return approval;
  }

  async executePlan(planOrId: string, approval?: { approvedBy: string }): Promise<OrchestrationRecord> {
    await this.init();
    const plan = this.requirePlan(planOrId); const goal = this.requireGoal(plan.goalId); const analysis = this.analyses.get(goal.id) ?? await this.analyzeGoal(goal);
    const validation = await this.validatePlan(plan);
    if (!validation.valid) throw new Error(`plan validation failed: ${validation.errors.map((issue) => issue.message).join('; ')}`);
    if (riskNeedsApproval(goal.risk, this.options) && !this.approved.has(plan.id) && !approval) throw new Error(`explicit authorization required before executing ${goal.risk} plan`);
    if (approval) await this.authorize(plan.id, approval.approvedBy);
    const orchestration: OrchestrationRecord = { id: id('orch'), goal: clone(goal), state: 'CREATED', analysis: clone(analysis), plan: clone(plan), validation: clone(validation), steps: plan.steps.map((step) => ({ stepId: step.id, status: 'pending', attempts: 0 })), replans: [], iteration: 0, createdAt: timestamp(), updatedAt: timestamp() };
    this.orchestrations.set(orchestration.id, orchestration); this.metricsState.plansExecuted += 1;
    await this.runtime.events.append({ type: 'orchestration.created', executionId: orchestration.id, payload: { orchestration }, idempotencyKey: `orchestration:${orchestration.id}:created` });
    try {
      await this.transition(orchestration, 'ANALYZING');
      await this.transition(orchestration, 'PLANNING');
      await this.transition(orchestration, 'VALIDATING');
      await this.transition(orchestration, 'READY');
      orchestration.team = await this.formTeam(orchestration.plan!, orchestration.analysis!);
      const started = Date.now();
      let completed = false;
      while (!completed) {
        await this.transition(orchestration, 'RUNNING');
        await this.executeSteps(orchestration);
        this.metricsState.averageExecutionDurationMs = this.average(this.metricsState.averageExecutionDurationMs, started, this.metricsState.plansExecuted);
        await this.transition(orchestration, 'EVALUATING');
        orchestration.evaluation = this.evaluator.evaluate(orchestration.goal, orchestration.analysis!, orchestration.plan!, orchestration.steps, this.runtime.agents.list());
        this.metricsState.evaluationScore = orchestration.evaluation.score;
        await this.runtime.events.append({ type: 'orchestration.evaluated', executionId: orchestration.id, payload: { orchestrationId: orchestration.id, evaluation: orchestration.evaluation } });
        if (orchestration.evaluation.success) { await this.learnPlan(orchestration, true); await this.transition(orchestration, 'COMPLETED'); this.metricsState.successfulPlans += 1; completed = true; }
        else if (orchestration.replans.length < orchestration.plan!.limits.maxReplans && orchestration.iteration < orchestration.plan!.limits.maxIterations) { const failed = orchestration.steps.find((step) => step.status === 'failed') ?? orchestration.steps[0]; if (!failed) throw new Error('evaluation failed without an identifiable step'); const failedPlanStep = orchestration.plan!.steps.find((step) => step.id === failed.stepId); if (!failedPlanStep) throw new Error('evaluation failed without a matching plan step'); await this.replanAndContinue(orchestration, 'low_evaluation_score', 'evaluation score below completion threshold', failedPlanStep, failed.agentId); }
        else { await this.learnPlan(orchestration, false); orchestration.error = 'evaluation failed and bounded replanning limit was reached'; await this.transition(orchestration, 'FAILED'); this.metricsState.failedPlans += 1; completed = true; }
      }
    } catch (error) {
      orchestration.error = error instanceof Error ? error.message : String(error);
      if (orchestration.state !== 'CANCELLED' && orchestration.state !== 'FAILED') await this.transition(orchestration, 'FAILED');
      this.metricsState.failedPlans += 1;
      await this.learnPlan(orchestration, false);
    }
    orchestration.updatedAt = timestamp(); this.orchestrations.set(orchestration.id, clone(orchestration));
    return clone(orchestration);
  }

  async run(input: Parameters<typeof createGoal>[0], approval?: { approvedBy: string }): Promise<OrchestrationRecord> { const goal = await this.createGoal(input); await this.analyzeGoal(goal); const plan = await this.createPlan(goal); return this.executePlan(plan.id, approval); }

  async observe(orchestrationId: string): Promise<{ orchestration: OrchestrationRecord; events: unknown[] }> { await this.init(); const orchestration = this.requireOrchestration(orchestrationId); return { orchestration: clone(orchestration), events: await this.runtime.events.read((event) => event.executionId === orchestrationId) }; }
  async evaluate(orchestrationId: string): Promise<import('./types.js').EvaluationResult> { await this.init(); const orchestration = this.requireOrchestration(orchestrationId); if (!orchestration.plan || !orchestration.analysis) throw new Error('orchestration has no plan or analysis'); orchestration.evaluation = this.evaluator.evaluate(orchestration.goal, orchestration.analysis, orchestration.plan, orchestration.steps, this.runtime.agents.list()); return clone(orchestration.evaluation); }
  async replan(orchestrationId: string, trigger: ReplanTrigger = 'manual'): Promise<OrchestrationRecord> { await this.init(); const orchestration = this.requireOrchestration(orchestrationId); const failed = orchestration.steps.find((step) => step.status === 'failed'); if (!failed || !orchestration.plan || !orchestration.analysis) throw new Error('no failed step is available for replanning'); await this.replanAndContinue(orchestration, trigger, failed.error ?? 'manual replan requested'); return clone(orchestration); }
  async cancel(orchestrationId: string): Promise<OrchestrationRecord> { await this.init(); const orchestration = this.requireOrchestration(orchestrationId); if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(orchestration.state)) await this.transition(orchestration, 'CANCELLED'); return clone(orchestration); }
  async status(orchestrationId: string): Promise<OrchestrationRecord> { await this.init(); return clone(this.requireOrchestration(orchestrationId)); }
  async metrics(): Promise<OrchestratorMetrics> { await this.init(); const records = [...this.orchestrations.values()]; const totalSteps = records.reduce((sum, record) => sum + record.steps.length, 0); const completedSteps = records.reduce((sum, record) => sum + record.steps.filter((step) => step.status === 'completed').length, 0); return { ...clone(this.metricsState), taskCompletionRate: totalSteps ? Number((completedSteps / totalSteps).toFixed(4)) : 0, replans: records.reduce((sum, record) => sum + record.replans.length, 0) }; }
  explain(orchestrationId: string): Record<string, unknown> { const record = this.requireOrchestration(orchestrationId); return { orchestrationId, state: record.state, goal: { id: record.goal.id, category: record.analysis?.category, risk: record.goal.risk, complexity: record.analysis?.complexity }, plan: record.plan ? { id: record.plan.id, topology: record.plan.recommendedTopology, steps: record.plan.steps.map((step) => ({ id: step.id, title: step.title, dependencies: step.dependencies, capabilities: step.requiredCapabilities, parallelizable: step.parallelizable })), rationale: this.planner.explain(record.plan) } : undefined, team: record.team ? { topology: record.team.topology, coordinatorId: record.team.coordinatorId, members: record.team.members } : undefined, selections: record.team?.selections.map((selection) => ({ stepId: selection.stepId, selectedAgentId: selection.selectedAgentId, role: selection.role, candidates: selection.candidates.slice(0, 5), rationale: selection.decision.rationale })) ?? [], replans: record.replans.map((decision) => ({ trigger: decision.trigger, failedStepId: decision.failedStepId, alternativeAgentId: decision.alternativeAgentId, rationale: decision.rationale })), evaluation: record.evaluation };
  }

  private async formTeam(plan: ExecutionPlan, analysis: GoalAnalysis): Promise<SwarmTeam> { const selector = new IntelligenceAgentSelector({ agents: this.runtime.agents.list(), router: this.runtime.router, learning: this.runtime.learning, subject: this.options.subject ?? 'orchestrator' }); const team = await selector.formTeam(plan, analysis); const swarm = new SwarmCoordinator(); const swarmPlan = swarm.plan(plan.steps.map((step) => ({ id: step.id, input: step.description, payload: step.title, ...(step.requiredCapabilities.length ? { requiredCapabilities: step.requiredCapabilities } : {}) })), this.runtime.agents.list(), swarmTopology(plan.recommendedTopology)); return { ...team, rationale: [...team.rationale, `swarmAssignments=${swarmPlan.assignments.length}`, `swarmTopology=${swarmPlan.topology}`, 'existing SwarmCoordinator used for deterministic topology planning'] }; }

  private async executeSteps(orchestration: OrchestrationRecord): Promise<void> {
    const plan = orchestration.plan!; const analysis = orchestration.analysis!; const pending = new Set(plan.steps.map((step) => step.id));
    while (pending.size) {
      if (orchestration.state === 'CANCELLED') return;
      if (orchestration.iteration >= plan.limits.maxIterations) throw new Error('orchestration exceeded maxIterations');
      const ready = plan.steps.filter((step) => pending.has(step.id) && step.dependencies.every((dependency) => orchestration.steps.find((record) => record.stepId === dependency)?.status === 'completed'));
      if (!ready.length) throw new Error('orchestration stalled: no dependency-satisfied step available');
      const batch = plan.recommendedTopology === 'parallel' || plan.recommendedTopology === 'mesh' ? ready.filter((step) => step.parallelizable) : [ready[0]!];
      for (const step of batch.length ? batch : [ready[0]!]) { await this.executeStepWithBounds(orchestration, step, analysis); if (orchestration.state === 'REPLANNING') { orchestration.iteration += 1; await this.transition(orchestration, 'RUNNING'); } if (orchestration.steps.find((record) => record.stepId === step.id)?.status === 'completed') pending.delete(step.id); else if (orchestration.steps.find((record) => record.stepId === step.id)?.status === 'failed') throw new Error(`step failed after bounded retries: ${step.id}`); }
    }
  }

  private async executeStepWithBounds(orchestration: OrchestrationRecord, step: PlanStep, analysis: GoalAnalysis): Promise<void> {
    const stepRecord = orchestration.steps.find((record) => record.stepId === step.id)!; const failedAgents: string[] = []; const maxAttempts = step.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      stepRecord.attempts = attempt; stepRecord.status = 'running'; stepRecord.startedAt = timestamp(); orchestration.updatedAt = timestamp();
      let selection = orchestration.team?.selections.find((candidate) => candidate.stepId === step.id);
      try {
        const selector = new IntelligenceAgentSelector({ agents: this.runtime.agents.list(), router: this.runtime.router, learning: this.runtime.learning, subject: this.options.subject ?? 'orchestrator' });
        selection = await selector.select(step, analysis, failedAgents);
        stepRecord.agentId = selection.selectedAgentId;
        await this.runtime.events.append({ type: 'agent.selected', executionId: orchestration.id, taskId: step.id, agentId: selection.selectedAgentId, payload: { stepId: step.id, selection } });
        const output = await timeout(this.executeStep(orchestration, step, selection.selectedAgentId, attempt), orchestration.goal.constraints.timeoutMs ?? 60_000);
        stepRecord.status = 'completed'; stepRecord.completedAt = timestamp(); stepRecord.output = output;
        await this.runtime.events.append({ type: 'intelligence.step.completed', executionId: orchestration.id, taskId: step.id, agentId: selection.selectedAgentId, payload: { step: clone(stepRecord), output: safeSummary(output) } });
        return;
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error); stepRecord.status = 'failed'; stepRecord.error = cause; failedAgents.push(selection?.selectedAgentId ?? '');
        await this.runtime.events.append({ type: 'intelligence.step.failed', executionId: orchestration.id, taskId: step.id, ...(selection?.selectedAgentId ? { agentId: selection.selectedAgentId } : {}), payload: { stepId: step.id, attempt, error: cause, trigger: /timeout/i.test(cause) ? 'timeout' : 'agent_failure' } });
        if (attempt < maxAttempts) continue;
        if (orchestration.replans.length < orchestration.plan!.limits.maxReplans && orchestration.iteration < orchestration.plan!.limits.maxIterations) { await this.replanAndContinue(orchestration, /timeout/i.test(cause) ? 'timeout' : 'agent_failure', cause, step, selection?.selectedAgentId); return; }
      }
    }
  }

  private async executeStep(orchestration: OrchestrationRecord, step: PlanStep, agentId: AgentId, attempt: number): Promise<unknown> {
    if (this.options.executeStep) return this.options.executeStep({ goal: orchestration.goal, plan: orchestration.plan!, step, agentId, attempt });
    const task: TaskRecord = { id: id('task'), executionId: orchestration.id as ExecutionId, title: step.title, description: step.description, dependencies: [], status: 'running', attempts: attempt, assignedAgentId: agentId };
    const lease = this.runtime.scheduler.acquire(task.id, agentId); if (!lease) throw new Error('capacity exhaustion: scheduler rejected step lease');
    const started = Date.now();
    try {
      await this.runtime.events.append({ type: 'intelligence.step.started', executionId: orchestration.id, taskId: step.id, agentId, payload: { stepId: step.id, attempt, leaseId: lease.id } });
      const result = await this.runtime.provider.execute({ goal: orchestration.goal.description, task, agent: this.runtime.agents.get(agentId).name });
      this.runtime.agents.recordOutcome(agentId, { taskType: classifyTask(step, orchestration.analysis!).taskType, domain: orchestration.analysis!.category, success: true, quality: result.quality, latencyMs: Date.now() - started, tokens: result.tokens, costUsd: result.costUsd });
      const learning = { executionId: orchestration.id, taskId: step.id, taskType: classifyTask(step, orchestration.analysis!).taskType, agentId, capabilities: step.requiredCapabilities, success: true, quality: result.quality, executionTimeMs: Date.now() - started, attempts: attempt, output: result.output };
      if (this.runtime.learningAsync) this.runtime.learning.enqueueSuccess(learning); else await this.runtime.learning.recordSuccess(learning);
      return result.output;
    } catch (error) {
      this.runtime.agents.recordOutcome(agentId, { taskType: classifyTask(step, orchestration.analysis!).taskType, domain: orchestration.analysis!.category, success: false, quality: 0, latencyMs: Date.now() - started, tokens: 0, timedOut: error instanceof Error && /timeout/i.test(error.message) });
      const learning = { executionId: orchestration.id, taskId: step.id, taskType: classifyTask(step, orchestration.analysis!).taskType, agentId, capabilities: step.requiredCapabilities, success: false, quality: 0, executionTimeMs: Date.now() - started, attempts: attempt, error: error instanceof Error ? error.message : String(error) };
      if (this.runtime.learningAsync) this.runtime.learning.enqueueFailure(learning); else await this.runtime.learning.recordFailure(learning);
      throw error;
    } finally { this.runtime.scheduler.release(lease.id); }
  }

  private async replanAndContinue(orchestration: OrchestrationRecord, trigger: ReplanTrigger, cause: string, failedStep?: PlanStep, failedAgentId?: AgentId): Promise<void> {
    const step = failedStep ?? orchestration.plan!.steps.find((candidate) => orchestration.steps.find((record) => record.stepId === candidate.id)?.status === 'failed');
    if (!step) throw new Error('cannot replan without failed step');
    if (orchestration.state !== 'REPLANNING') await this.transition(orchestration, 'REPLANNING');
    const selector = new IntelligenceAgentSelector({ agents: this.runtime.agents.list(), router: this.runtime.router, learning: this.runtime.learning, subject: this.options.subject ?? 'orchestrator' });
    const replanner = new IntelligenceReplanner(this.runtime, selector); const decision = await replanner.decide({ goal: orchestration.goal, analysis: orchestration.analysis!, plan: orchestration.plan!, step, trigger, cause, ...(failedAgentId ? { failedAgentId } : {}), subject: this.options.subject ?? 'orchestrator' });
    orchestration.plan = replanner.apply(orchestration.plan!, decision); orchestration.replans.push(decision); orchestration.iteration += 1; this.metricsState.agentSelectionChanges += decision.alternativeAgentId ? 1 : 0; const stepRecord = orchestration.steps.find((record) => record.stepId === step.id)!; stepRecord.status = 'pending'; delete stepRecord.error; orchestration.updatedAt = timestamp();
    await this.runtime.events.append({ type: 'plan.replanned', executionId: orchestration.id, payload: { orchestrationId: orchestration.id, decision, plan: orchestration.plan } });
    await this.learnReplan(orchestration, decision);
  }

  private async learnPlan(orchestration: OrchestrationRecord, success: boolean): Promise<void> { const plan = orchestration.plan; if (!plan) return; try { await this.runtime.rememberEntry({ namespace: 'global', type: success ? 'pattern' : 'failure', content: success ? `Successful autonomous plan pattern for ${orchestration.analysis?.category ?? 'general'} goal` : `Failed autonomous plan pattern requiring bounded replanning for ${orchestration.analysis?.category ?? 'general'} goal`, metadata: { orchestrationId: orchestration.id, planId: plan.id, success: success ? 1 : 0, topology: plan.recommendedTopology, stepCount: plan.steps.length }, source: 'intelligence', confidence: success ? 0.75 : 0.65, tags: ['intelligence', `topology:${plan.recommendedTopology}`, success ? 'successful-plan' : 'failed-plan'], provenance: { sourceType: 'system', sourceId: orchestration.id, timestamp: timestamp(), confidence: success ? 0.75 : 0.65, executionId: orchestration.id }, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }); } catch (error) { await this.runtime.events.append({ type: 'intelligence.learning.failed', executionId: orchestration.id, payload: { error: error instanceof Error ? error.message : String(error) } }); } }
  private async learnReplan(orchestration: OrchestrationRecord, decision: ReplanDecision): Promise<void> { try { await this.runtime.rememberEntry({ namespace: 'global', type: 'pattern', content: `Bounded replanning pattern for ${decision.trigger ?? 'unknown'} on ${decision.failedStepId ?? 'unknown'}: ${decision.alternativeAgentId ?? 'no alternative'}`, metadata: { orchestrationId: orchestration.id, trigger: decision.trigger ?? 'unknown', failedStepId: decision.failedStepId ?? 'unknown', alternativeAgentId: decision.alternativeAgentId ?? 'none' }, source: 'intelligence-replanner', confidence: 0.7, tags: ['replanning', `trigger:${decision.trigger ?? 'unknown'}`], provenance: { sourceType: 'system', sourceId: orchestration.id, timestamp: timestamp(), confidence: 0.7, executionId: orchestration.id }, accessPolicy: { visibility: 'public', allowedSubjects: ['*'], allowedSwarmIds: [], owner: 'system' } }); } catch { /* learning failure is observable through orchestration events, never fatal to recovery */ } }

  private async transition(orchestration: OrchestrationRecord, next: OrchestrationState): Promise<void> { if (!transitions[orchestration.state].includes(next)) throw new Error(`invalid orchestration transition ${orchestration.state} -> ${next}`); const previous = orchestration.state; orchestration.state = next; orchestration.updatedAt = timestamp(); await this.runtime.events.append({ type: 'orchestration.state_changed', executionId: orchestration.id, payload: { orchestrationId: orchestration.id, previous, state: next, updatedAt: orchestration.updatedAt } }); }
  private average(previous: number, started: number, count: number): number { const duration = Date.now() - started; return Number((((previous * Math.max(0, count - 1)) + duration) / Math.max(1, count)).toFixed(3)); }
  private requireGoal(goalId: string): Goal { const goal = this.goals.get(goalId); if (!goal) throw new Error(`Unknown goal: ${goalId}`); return goal; }
  private requirePlan(planId: string): ExecutionPlan { const plan = this.plans.get(planId); if (!plan) throw new Error(`Unknown plan: ${planId}`); return plan; }
  private requireOrchestration(idValue: string): OrchestrationRecord { const record = this.orchestrations.get(idValue); if (!record) throw new Error(`Unknown orchestration: ${idValue}`); return record; }
  private rebuild(type: string, payload: Record<string, unknown>, executionId?: string): void { if (type === 'goal.created' && payload.goal) { const goal = payload.goal as Goal; this.goals.set(goal.id, clone(goal)); } else if (type === 'goal.analyzed' && payload.goalId && payload.analysis) this.analyses.set(String(payload.goalId), clone(payload.analysis as GoalAnalysis)); else if (type === 'plan.created' && payload.plan) { const plan = payload.plan as ExecutionPlan; this.plans.set(plan.id, clone(plan)); } else if (type === 'orchestration.created' && payload.orchestration) { const record = payload.orchestration as OrchestrationRecord; this.orchestrations.set(record.id, clone(record)); } else if (type === 'orchestration.state_changed' && payload.orchestrationId) { const record = this.orchestrations.get(String(payload.orchestrationId)); if (record && typeof payload.state === 'string') record.state = payload.state as OrchestrationState; } else if ((type === 'intelligence.step.completed' || type === 'intelligence.step.failed') && payload.stepId) { const record = this.orchestrations.get(String(payload.orchestrationId ?? executionId ?? '')); if (record) { const existing = record.steps.find((candidate) => candidate.stepId === String(payload.stepId)); if (existing) { existing.status = type.endsWith('completed') ? 'completed' : 'failed'; existing.attempts = typeof payload.attempt === 'number' ? payload.attempt : existing.attempts; if (type.endsWith('failed') && typeof payload.error === 'string') existing.error = payload.error; } } } else if (type === 'orchestration.evaluated' && payload.orchestrationId && payload.evaluation) { const record = this.orchestrations.get(String(payload.orchestrationId)); if (record) record.evaluation = clone(payload.evaluation as import('./types.js').EvaluationResult); } else if (type === 'plan.replanned' && payload.orchestrationId && payload.plan) { const record = this.orchestrations.get(String(payload.orchestrationId)); if (record) { record.plan = clone(payload.plan as ExecutionPlan); if (payload.decision) record.replans.push(clone(payload.decision as ReplanDecision)); } } }
}
