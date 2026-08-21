import type { AgentId, ExecutionId, TaskId } from '../../core/src/index.js';
import type { RoutingDecision } from '../../router/src/index.js';

export type GoalRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type GoalCategory = 'software' | 'security' | 'research' | 'documentation' | 'operations' | 'analysis' | 'general';
export type PlanTopology = 'sequential' | 'parallel' | 'pipeline' | 'hierarchical' | 'mesh' | 'adaptive';
export type Complexity = 'low' | 'medium' | 'high' | 'very-high';
export type OrchestrationState = 'CREATED' | 'ANALYZING' | 'PLANNING' | 'VALIDATING' | 'READY' | 'RUNNING' | 'EVALUATING' | 'REPLANNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type ReplanTrigger = 'agent_failure' | 'timeout' | 'dependency_failure' | 'low_evaluation_score' | 'unhealthy_agent' | 'capacity_exhaustion' | 'security_rejection' | 'manual';

export interface GoalConstraints {
  maxAgents?: number;
  maxTasks?: number;
  maxDepth?: number;
  maxFanout?: number;
  maxReplans?: number;
  maxRetriesPerStep?: number;
  maxIterations?: number;
  timeoutMs?: number;
  requireApproval?: boolean;
  allowSandbox?: boolean;
  requiredTopology?: PlanTopology;
  deniedCapabilities?: string[];
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  constraints: GoalConstraints;
  requiredCapabilities: string[];
  priority: number;
  urgency: number;
  risk: GoalRisk;
  expectedOutcome: string;
  createdAt: string;
}

export interface GoalAnalysis {
  goalId: string;
  category: GoalCategory;
  requiredCapabilities: string[];
  complexity: Complexity;
  complexityScore: number;
  dependencies: string[];
  risk: GoalRisk;
  likelyTopology: PlanTopology;
  expectedAgents: number;
  rationale: string[];
  deterministic: true;
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  requiredCapabilities: string[];
  priority: number;
  dependencies: string[];
  estimatedComplexity: Complexity;
  preferredAgentTypes: string[];
  parallelizable: boolean;
  maxRetries: number;
  depth: number;
}

export interface ExecutionPlan {
  id: string;
  goalId: string;
  steps: PlanStep[];
  dependencies: Record<string, string[]>;
  recommendedTopology: PlanTopology;
  requiredCapabilities: string[];
  estimatedComplexity: Complexity;
  risk: GoalRisk;
  createdAt: string;
  limits: Required<Pick<GoalConstraints, 'maxDepth' | 'maxTasks' | 'maxFanout' | 'maxReplans' | 'maxRetriesPerStep' | 'maxIterations'>>;
}

export interface PlanValidationIssue { code: string; message: string; stepId?: string; severity: 'error' | 'warning'; }
export interface PlanValidationResult { valid: boolean; errors: PlanValidationIssue[]; warnings: PlanValidationIssue[]; checkedAt: string; satisfiableAgentIds: AgentId[]; rationale: string[]; }

export interface AgentSelectionScore {
  agentId: AgentId;
  score: number;
  capabilityMatch: number;
  availability: number;
  health: number;
  reputation: number;
  specialization: number;
  historicalSuccess: number;
  memoryBonus: number;
  rationale: string[];
}

export interface AgentSelection {
  stepId: string;
  selectedAgentId: AgentId;
  candidates: AgentSelectionScore[];
  decision: RoutingDecision;
  role: string;
}

export interface SwarmTeam {
  topology: PlanTopology;
  coordinatorId: AgentId;
  members: Array<{ agentId: AgentId; role: 'coordinator' | 'implementer' | 'reviewer' | 'tester' | 'security' | 'specialist'; stepIds: string[] }>;
  selections: AgentSelection[];
  rationale: string[];
}

export interface StepExecutionRecord {
  stepId: string;
  taskId?: TaskId;
  agentId?: AgentId;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  output?: unknown;
  error?: string;
}

export interface EvaluationResult {
  success: boolean;
  score: number;
  completedSteps: number;
  failedSteps: number;
  warnings: string[];
  recommendations: string[];
  dependencyCompletion: number;
  outputPresence: number;
  retryPenalty: number;
  timeoutCount: number;
  agentReliability: number;
  securityViolations: number;
  goalCoverage: number;
}

export interface ReplanDecision {
  triggered: boolean;
  trigger?: ReplanTrigger;
  failedStepId?: string;
  cause?: string;
  alternativeAgentId?: AgentId;
  modifiedStep?: PlanStep;
  rationale: string[];
  memoryHints: string[];
}

export interface OrchestratorMetrics {
  goalsCreated: number;
  goalsAnalyzed: number;
  plansCreated: number;
  plansRejected: number;
  plansExecuted: number;
  successfulPlans: number;
  failedPlans: number;
  replans: number;
  averagePlanDurationMs: number;
  averageExecutionDurationMs: number;
  agentSelectionChanges: number;
  taskCompletionRate: number;
  evaluationScore: number;
  memoryHits: number;
  memoryMisses: number;
}

export interface OrchestrationRecord {
  id: string;
  goal: Goal;
  state: OrchestrationState;
  analysis?: GoalAnalysis;
  plan?: ExecutionPlan;
  validation?: PlanValidationResult;
  team?: SwarmTeam;
  steps: StepExecutionRecord[];
  evaluation?: EvaluationResult;
  replans: ReplanDecision[];
  iteration: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: unknown;
}

export interface OrchestratorOptions {
  maxReplans?: number;
  maxRetriesPerStep?: number;
  maxIterations?: number;
  approvalRequiredFor?: GoalRisk[];
  subject?: string;
  executeStep?: (input: { goal: Goal; plan: ExecutionPlan; step: PlanStep; agentId: AgentId; attempt: number; signal?: AbortSignal }) => Promise<unknown>;
}
