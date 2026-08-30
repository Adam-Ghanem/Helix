import { AgentHealth, AgentId, AgentProfile, timestamp, id } from '../../core/src/index.js';

export interface AgentTemplate {
  name: string;
  role: string;
  capabilities: string[];
}

const CATALOG: AgentTemplate[] = [
  { name: 'architect', role: 'Architecture analysis', capabilities: ['architecture', 'analysis'] },
  { name: 'planner', role: 'Task planning', capabilities: ['planning', 'analysis'] },
  { name: 'supervisor', role: 'Agent supervision and delegation', capabilities: ['supervision', 'planning', 'analysis'] },
  { name: 'judge', role: 'Final decision and evidence judging', capabilities: ['judging', 'review', 'quality'] },
  { name: 'critic', role: 'Adversarial critique', capabilities: ['critique', 'review', 'quality'] },
  { name: 'coder', role: 'General implementation', capabilities: ['coding', 'typescript', 'python'] },
  { name: 'code-reviewer', role: 'Source code review', capabilities: ['coding', 'review', 'quality'] },
  { name: 'reviewer', role: 'Code and result review', capabilities: ['review', 'quality'] },
  { name: 'tester', role: 'Validation and testing', capabilities: ['testing', 'quality'] },
  { name: 'debugger', role: 'Failure diagnosis', capabilities: ['debugging', 'analysis'] },
  { name: 'researcher', role: 'Evidence gathering', capabilities: ['research', 'analysis'] },
  { name: 'analyst', role: 'Structured analysis', capabilities: ['analysis', 'reporting'] },
  { name: 'backend', role: 'Backend engineering', capabilities: ['coding', 'backend'] },
  { name: 'frontend', role: 'Frontend engineering', capabilities: ['coding', 'frontend'] },
  { name: 'fullstack', role: 'Full-stack engineering', capabilities: ['coding', 'backend', 'frontend'] },
  { name: 'database', role: 'Data systems', capabilities: ['coding', 'database'] },
  { name: 'data-engineer', role: 'Data pipeline engineering', capabilities: ['coding', 'data', 'database'] },
  { name: 'ml-engineer', role: 'Machine learning engineering', capabilities: ['coding', 'ml', 'data'] },
  { name: 'ai-evaluator', role: 'Model and agent evaluation', capabilities: ['evaluation', 'quality', 'analysis'] },
  { name: 'prompt-engineer', role: 'Prompt and instruction design', capabilities: ['prompting', 'analysis'] },
  { name: 'context-engineer', role: 'Context assembly and compression', capabilities: ['context', 'memory', 'analysis'] },
  { name: 'memory-curator', role: 'Memory quality and consolidation', capabilities: ['memory', 'quality'] },
  { name: 'knowledge-engineer', role: 'Knowledge graph engineering', capabilities: ['knowledge', 'graph', 'data'] },
  { name: 'search-specialist', role: 'Search and retrieval design', capabilities: ['search', 'retrieval', 'analysis'] },
  { name: 'rag-engineer', role: 'Retrieval-augmented generation', capabilities: ['retrieval', 'memory', 'coding'] },
  { name: 'security', role: 'Defensive security review', capabilities: ['security', 'threat-modeling'] },
  { name: 'security-architect', role: 'Security architecture', capabilities: ['security', 'architecture', 'threat-modeling'] },
  { name: 'threat-modeler', role: 'Threat modeling', capabilities: ['security', 'threat-modeling', 'analysis'] },
  { name: 'threat-hunter', role: 'Threat hunting', capabilities: ['security', 'threat-hunting', 'analysis'] },
  { name: 'incident-responder', role: 'Incident handling', capabilities: ['security', 'operations'] },
  { name: 'dependency-auditor', role: 'Dependency review', capabilities: ['security', 'dependencies'] },
  { name: 'supply-chain-auditor', role: 'Software supply-chain review', capabilities: ['security', 'dependencies', 'release'] },
  { name: 'privacy-reviewer', role: 'Privacy and data handling review', capabilities: ['privacy', 'security', 'review'] },
  { name: 'policy-auditor', role: 'Policy and authorization review', capabilities: ['policy', 'security', 'review'] },
  { name: 'devops', role: 'Operations and deployment', capabilities: ['devops', 'deployment'] },
  { name: 'sre', role: 'Site reliability engineering', capabilities: ['operations', 'reliability', 'devops'] },
  { name: 'platform-engineer', role: 'Platform engineering', capabilities: ['platform', 'devops', 'coding'] },
  { name: 'cloud-architect', role: 'Cloud architecture', capabilities: ['cloud', 'architecture', 'deployment'] },
  { name: 'container-specialist', role: 'Container runtime engineering', capabilities: ['containers', 'deployment', 'security'] },
  { name: 'kubernetes-specialist', role: 'Kubernetes engineering', capabilities: ['kubernetes', 'deployment', 'operations'] },
  { name: 'network-engineer', role: 'Network engineering', capabilities: ['networking', 'operations'] },
  { name: 'api-designer', role: 'API contract design', capabilities: ['api', 'architecture', 'backend'] },
  { name: 'integration-engineer', role: 'System integration', capabilities: ['integration', 'coding', 'api'] },
  { name: 'mcp-specialist', role: 'MCP integration engineering', capabilities: ['mcp', 'integration', 'tools'] },
  { name: 'tooling-engineer', role: 'Agent tool engineering', capabilities: ['tools', 'coding', 'integration'] },
  { name: 'sandbox-reviewer', role: 'Execution sandbox review', capabilities: ['sandbox', 'security', 'review'] },
  { name: 'performance-engineer', role: 'Performance optimization', capabilities: ['performance', 'profiling', 'coding'] },
  { name: 'load-tester', role: 'Load and stress testing', capabilities: ['testing', 'performance'] },
  { name: 'reliability-reviewer', role: 'Reliability review', capabilities: ['reliability', 'review', 'quality'] },
  { name: 'chaos-engineer', role: 'Failure injection and resilience', capabilities: ['reliability', 'testing', 'operations'] },
  { name: 'release-manager', role: 'Release verification', capabilities: ['release', 'verification'] },
  { name: 'build-engineer', role: 'Build systems', capabilities: ['build', 'coding', 'release'] },
  { name: 'ci-engineer', role: 'Continuous integration engineering', capabilities: ['ci', 'testing', 'release'] },
  { name: 'documentation', role: 'Technical documentation', capabilities: ['documentation', 'writing'] },
  { name: 'technical-writer', role: 'Developer-facing writing', capabilities: ['documentation', 'writing', 'developer-experience'] },
  { name: 'ux-reviewer', role: 'User experience review', capabilities: ['ux', 'review', 'frontend'] },
  { name: 'accessibility-reviewer', role: 'Accessibility review', capabilities: ['accessibility', 'review', 'frontend'] },
  { name: 'product-analyst', role: 'Product analysis', capabilities: ['product', 'analysis', 'reporting'] },
  { name: 'requirements-analyst', role: 'Requirements analysis', capabilities: ['requirements', 'analysis', 'planning'] },
  { name: 'cost-optimizer', role: 'Runtime cost optimization', capabilities: ['cost', 'analysis', 'optimization'] },
  { name: 'token-optimizer', role: 'Token and context optimization', capabilities: ['tokens', 'context', 'optimization'] },
  { name: 'observability-engineer', role: 'Telemetry and observability', capabilities: ['observability', 'operations', 'coding'] },
  { name: 'forensics-analyst', role: 'Digital forensics analysis', capabilities: ['security', 'forensics', 'analysis'] },
  { name: 'compliance-reviewer', role: 'Compliance review', capabilities: ['compliance', 'policy', 'review'] },
  { name: 'migration-engineer', role: 'System migration engineering', capabilities: ['migration', 'coding', 'architecture'] },
];

function initialHealth(): AgentHealth {
  return { successRate: 0.5, failureRate: 0, latencyMs: 1_000, tokenConsumption: 0, toolFailures: 0, timeouts: 0, retries: 0, qualityScore: 0.5, samples: 0 };
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, AgentProfile>();

  constructor(seed = true) {
    if (seed) for (const template of CATALOG) this.register(template);
  }

  register(input: { name: string; role: string; capabilities: string[]; permissions?: string[]; model?: string; provider?: string }): AgentProfile {
    const profile: AgentProfile = {
      id: id('agent'),
      name: input.name,
      role: input.role,
      capabilities: [...new Set(input.capabilities)],
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      permissions: [...new Set(input.permissions ?? [])],
      status: 'idle',
      health: initialHealth(),
      reputation: [],
    };
    this.agents.set(profile.id, profile);
    return structuredClone(profile);
  }

  restore(profile: AgentProfile): AgentProfile {
    const existing = this.agents.get(profile.id);
    if (existing) return structuredClone(existing);
    const restored: AgentProfile = {
      ...structuredClone(profile),
      capabilities: [...new Set(profile.capabilities)],
      permissions: [...new Set(profile.permissions)],
      health: structuredClone(profile.health),
      reputation: structuredClone(profile.reputation),
    };
    this.agents.set(restored.id, restored);
    return structuredClone(restored);
  }

  remove(agentId: AgentId): boolean {
    return this.agents.delete(agentId);
  }

  list(): AgentProfile[] {
    return [...this.agents.values()].map((agent) => structuredClone(agent));
  }

  findByName(name: string): AgentProfile | undefined {
    const agent = [...this.agents.values()].find((candidate) => candidate.name === name);
    return agent ? structuredClone(agent) : undefined;
  }

  findByCapabilities(required: string[]): AgentProfile[] {
    return [...this.agents.values()]
      .filter((agent) => required.every((capability) => agent.capabilities.includes(capability)))
      .map((agent) => structuredClone(agent));
  }

  templates(): AgentTemplate[] {
    return CATALOG.map((template) => ({ ...template, capabilities: [...template.capabilities] }));
  }

  get(agentId: AgentId): AgentProfile {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return structuredClone(agent);
  }

  setStatus(agentId: AgentId, status: AgentProfile['status']): void {
    const agent = this.require(agentId);
    agent.status = status;
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
