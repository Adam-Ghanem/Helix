import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgentRegistry, AgentTemplate } from '../../agents/src/index.js';
import { AgentProfile, timestamp } from '../../core/src/index.js';

export type DynamicAgentStatus = 'active' | 'terminated';

export interface DynamicAgentInstance {
  agentId: string;
  templateName: string;
  parentAgentId?: string;
  objective?: string;
  depth: number;
  status: DynamicAgentStatus;
  createdAt: string;
  updatedAt: string;
  profile: AgentProfile;
}

export interface AutonomousAgentSystemOptions {
  registry: AgentRegistry;
  stateFile: string;
  maxDynamicAgents?: number;
  maxDelegationDepth?: number;
}

export interface SpawnOptions {
  parentAgentId?: string;
  objective?: string;
}

export interface DelegationRequest {
  parentAgentId: string;
  objective: string;
  requiredCapabilities: string[];
}

export class AutonomousAgentSystem {
  private readonly registry: AgentRegistry;
  private readonly stateFile: string;
  private readonly maxDynamicAgents: number;
  private readonly maxDelegationDepth: number;
  private readonly templates: AgentTemplate[];
  private readonly instances = new Map<string, DynamicAgentInstance>();
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: AutonomousAgentSystemOptions) {
    if (!Number.isInteger(options.maxDynamicAgents ?? 16) || (options.maxDynamicAgents ?? 16) < 1) throw new Error('maxDynamicAgents must be a positive integer');
    if (!Number.isInteger(options.maxDelegationDepth ?? 3) || (options.maxDelegationDepth ?? 3) < 0) throw new Error('maxDelegationDepth must be a non-negative integer');
    this.registry = options.registry;
    this.stateFile = options.stateFile;
    this.maxDynamicAgents = options.maxDynamicAgents ?? 16;
    this.maxDelegationDepth = options.maxDelegationDepth ?? 3;
    this.templates = this.registry.templates();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.stateFile), { recursive: true });
    try {
      const persisted = JSON.parse(await readFile(this.stateFile, 'utf8')) as DynamicAgentInstance[];
      if (!Array.isArray(persisted)) throw new Error('Autonomy state must be an array');
      for (const instance of persisted) {
        this.validateInstance(instance);
        this.instances.set(instance.agentId, structuredClone(instance));
        if (instance.status === 'active') this.registry.restore(instance.profile);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async spawn(templateName: string, options: SpawnOptions = {}): Promise<DynamicAgentInstance> {
    await this.init();
    this.assertCapacity();
    const template = this.templates.find((candidate) => candidate.name === templateName);
    if (!template) throw new Error(`Unknown agent template: ${templateName}`);
    const parent = options.parentAgentId ? this.requireActive(options.parentAgentId) : undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.maxDelegationDepth) throw new Error(`Delegation depth ${depth} exceeds max delegation depth ${this.maxDelegationDepth}`);

    const profile = this.registry.register({
      name: template.name,
      role: template.role,
      capabilities: template.capabilities,
    });
    const now = timestamp();
    const instance: DynamicAgentInstance = {
      agentId: profile.id,
      templateName: template.name,
      ...(parent ? { parentAgentId: parent.agentId } : {}),
      ...(options.objective ? { objective: options.objective } : {}),
      depth,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      profile,
    };
    this.instances.set(instance.agentId, instance);
    await this.persist();
    return structuredClone(instance);
  }

  async delegate(request: DelegationRequest): Promise<DynamicAgentInstance> {
    await this.init();
    const parent = this.requireActive(request.parentAgentId);
    const depth = parent.depth + 1;
    if (depth > this.maxDelegationDepth) throw new Error(`Delegation depth ${depth} exceeds max delegation depth ${this.maxDelegationDepth}`);
    const template = this.selectTemplate(request.requiredCapabilities);
    if (!template) throw new Error(`No agent template satisfies capabilities: ${request.requiredCapabilities.join(', ')}`);
    return this.spawn(template.name, { parentAgentId: parent.agentId, objective: request.objective });
  }

  async terminate(agentId: string): Promise<DynamicAgentInstance> {
    await this.init();
    const instance = this.requireActive(agentId);
    instance.status = 'terminated';
    instance.updatedAt = timestamp();
    this.registry.remove(agentId);
    await this.persist();
    return structuredClone(instance);
  }

  list(includeTerminated = false): DynamicAgentInstance[] {
    return [...this.instances.values()]
      .filter((instance) => includeTerminated || instance.status === 'active')
      .map((instance) => structuredClone(instance));
  }

  get(agentId: string): DynamicAgentInstance | undefined {
    const instance = this.instances.get(agentId);
    return instance ? structuredClone(instance) : undefined;
  }

  children(parentAgentId: string): DynamicAgentInstance[] {
    return [...this.instances.values()]
      .filter((instance) => instance.parentAgentId === parentAgentId && instance.status === 'active')
      .map((instance) => structuredClone(instance));
  }

  private selectTemplate(requiredCapabilities: string[]): AgentTemplate | undefined {
    const required = [...new Set(requiredCapabilities)];
    return this.templates
      .filter((template) => required.every((capability) => template.capabilities.includes(capability)))
      .sort((left, right) => {
        const leftExtra = left.capabilities.length - required.length;
        const rightExtra = right.capabilities.length - required.length;
        return leftExtra - rightExtra || left.name.localeCompare(right.name);
      })[0];
  }

  private activeCount(): number {
    return [...this.instances.values()].filter((instance) => instance.status === 'active').length;
  }

  private assertCapacity(): void {
    if (this.activeCount() >= this.maxDynamicAgents) throw new Error(`Dynamic-agent capacity ${this.maxDynamicAgents} reached`);
  }

  private requireActive(agentId: string): DynamicAgentInstance {
    const instance = this.instances.get(agentId);
    if (!instance || instance.status !== 'active') throw new Error(`Unknown or inactive dynamic agent: ${agentId}`);
    return instance;
  }

  private validateInstance(instance: DynamicAgentInstance): void {
    if (!instance || typeof instance.agentId !== 'string' || typeof instance.templateName !== 'string') throw new Error('Invalid autonomous agent state');
    if (!Number.isInteger(instance.depth) || instance.depth < 0 || instance.depth > this.maxDelegationDepth) throw new Error(`Invalid delegation depth for ${instance.agentId}`);
    if (!['active', 'terminated'].includes(instance.status)) throw new Error(`Invalid dynamic agent status for ${instance.agentId}`);
    if (!instance.profile || instance.profile.id !== instance.agentId) throw new Error(`Invalid profile snapshot for ${instance.agentId}`);
  }

  private async persist(): Promise<void> {
    await this.enqueue(async () => {
      const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.instances.values()], null, 2), 'utf8');
      await rename(temporary, this.stateFile);
    });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }
}
