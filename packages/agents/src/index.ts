import { AgentHealth, AgentId, AgentProfile, timestamp, id } from '../../core/src/index.js';

export interface AgentTypeDefinition {
  type: string;
  role: string;
  capabilities: string[];
}

export const AGENT_TYPES: readonly AgentTypeDefinition[] = [
  ['architect', 'Architecture analysis', ['architecture', 'analysis']],
  ['planner', 'Task planning', ['planning', 'analysis']],
  ['coder', 'Implementation', ['coding', 'typescript', 'python']],
  ['reviewer', 'Code and result review', ['review', 'quality']],
  ['tester', 'Validation and testing', ['testing', 'quality']],
  ['debugger', 'Failure diagnosis', ['debugging', 'analysis']],
  ['security-architect', 'Security architecture', ['security', 'threat-modeling', 'architecture']],
  ['researcher', 'Evidence gathering', ['research', 'analysis']],
  ['performance-engineer', 'Performance engineering', ['performance', 'profiling', 'optimization']],
  ['memory-specialist', 'Memory and retrieval', ['memory', 'retrieval', 'knowledge']],
  ['analyst', 'Structured analysis', ['analysis', 'reporting']],
  ['backend', 'Backend engineering', ['coding', 'backend']],
  ['frontend', 'Frontend engineering', ['coding', 'frontend']],
  ['database', 'Data systems', ['coding', 'database']],
  ['devops', 'Operations', ['devops', 'deployment']],
  ['documentation', 'Technical documentation', ['documentation', 'writing']],
  ['dependency-auditor', 'Dependency review', ['security', 'dependencies']],
  ['incident-responder', 'Incident handling', ['security', 'operations']],
  ['release-manager', 'Release verification', ['release', 'verification']],
  ['qa-engineer', 'Quality engineering', ['testing', 'quality', 'automation']],
  ['api-engineer', 'API engineering', ['coding', 'api', 'backend']],
  ['mcp-specialist', 'MCP integration', ['mcp', 'tools', 'integration']],
  ['workflow-engineer', 'Workflow design', ['workflow', 'orchestration', 'planning']],
  ['cost-optimizer', 'Cost optimization', ['cost', 'optimization', 'analysis']],
  ['compliance-auditor', 'Compliance auditing', ['compliance', 'audit', 'security']],
] as const;

const CATALOG: AgentTypeDefinition[] = AGENT_TYPES.map(([type, role, capabilities]) => ({ type, role, capabilities: [...capabilities] }));

function initialHealth(): AgentHealth {
  return { successRate: 0.5, failureRate: 0, latencyMs: 1_000, tokenConsumption: 0, toolFailures: 0, timeouts: 0, retries: 0, qualityScore: 0.5, samples: 0 };
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, AgentProfile>();

  constructor(seed = true, seedCount = 100) {
    if (seed) this.seed(seedCount);
  }

  seed(count: number): AgentProfile[] {
    if (!Number.isInteger(count) || count < 0) throw new Error('Agent seed count must be a non-negative integer');
    const created: AgentProfile[] = [];
    for (let index = 0; index < count; index += 1) {
      const template = CATALOG[index % CATALOG.length];
      const ordinal = Math.floor(index / CATALOG.length) + 1;
      created.push(this.register({
        name: `${template.type}-${String(ordinal).padStart(2, '0')}`,
        role: template.role,
        capabilities: template.capabilities,
      }));
    }
    return created;
  }

  register(input: { name: string; role: string; capabilities: string[]; permissions?: string[]; model?: string; provider?: string }): AgentProfile {
    if (this.list().some((agent) => agent.name === input.name)) throw new Error(`Agent already registered: ${input.name}`);
    const profile: AgentProfile = {
      id: id('agent'),
      name: input.name,
      role: input.role,
      capabilities: [...new Set(input.capabilities)],
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      permissions: [...(input.permissions ?? [])],
      status: 'idle',
      health: initialHealth(),
      reputation: [],
    };
    this.agents.set(profile.id, profile);
    return structuredClone(profile);
  }

  list(): AgentProfile[] {
    return [...this.agents.values()].map((agent) => structuredClone(agent));
  }

  get(agentId: AgentId): AgentProfile {
    return structuredClone(this.require(agentId));
  }

  setStatus(agentId: AgentId, status: AgentProfile['status']): void {
    this.require(agentId).status = status;
  }

  recordOutcome(agentId: AgentId, input: { taskType: string; domain: string; success: boolean; quality: number; latencyMs: number; tokens: number; toolFailures?: number; timedOut?: boolean; costUsd?: number }): void {
    const agent = this.require(agentId);
    const sample = agent.health.samples + 1;
    agent.health.successRate = ((agent.health.successRate * agent.health.samples) + (input.success ? 1 : 0)) / sample;
    agent.health.failureRate = 1 - agent.health.successRate;
    agent.health.qualityScore = ((agent.health.qualityScore * agent.health.samples) + Math.max(0, Math.min(1, input.quality))) / sample;
    agent.health.latencyMs = ((agent.health.latencyMs * agent.health.samples) + input.latencyMs) / sample;
    agent.health.tokenConsumption += input.tokens;
    agent.health.toolFailures += input.toolFailures ?? 0;
    agent.health.timeouts += input.timedOut ? 1 : 0;
    agent.health.samples = sample;
    const existing = agent.reputation.find((record) => record.taskType === input.taskType && record.domain === input.domain);
    if (existing) {
      existing.score = 0.9 * existing.score + 0.1 * input.quality;
      existing.samples += 1;
      existing.lastUpdated = timestamp();
    } else {
      agent.reputation.push({ taskType: input.taskType, domain: input.domain, score: input.quality, samples: 1, lastUpdated: timestamp() });
    }
  }

  reputation(agentId: AgentId, taskType: string, domain: string): number {
    const agent = this.require(agentId);
    const record = agent.reputation.find((candidate) => candidate.taskType === taskType && candidate.domain === domain);
    if (!record) return agent.health.qualityScore;
    const ageDays = Math.max(0, (Date.now() - Date.parse(record.lastUpdated)) / 86_400_000);
    const decay = Math.exp(-ageDays / 30);
    const exploration = 1 / Math.sqrt(record.samples + 1);
    return Math.max(0, Math.min(1, record.score * decay + 0.15 * exploration));
  }

  private require(agentId: AgentId): AgentProfile {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }
}
