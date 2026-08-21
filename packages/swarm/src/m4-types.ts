import type { AgentId } from '../../core/src/index.js';
export type M4SwarmTopology = 'hierarchical' | 'mesh' | 'adaptive';
export type M4SwarmStatus = 'idle' | 'running' | 'completed' | 'stopped' | 'failed';
export interface M4SwarmTask { id: string; title: string; description: string; requiredCapabilities: string[]; priority?: number }
export interface M4SwarmConfig { topology: M4SwarmTopology; maxAgents: number; name?: string; requiredCapabilities?: string[]; failureRateThreshold?: number; queueWaitThresholdMs?: number }
export interface M4SwarmAssignment { task: M4SwarmTask; agentId: AgentId; role: 'coordinator' | 'worker' | 'peer' }
export interface M4SwarmMetrics { status: M4SwarmStatus; topology: M4SwarmTopology; agents: number; tasks: number; completed: number; failed: number; active: number; topologyChanges: number }
export type M4SwarmEvent = { type: 'swarm.created' | 'swarm.task.submitted' | 'swarm.completed' | 'topology.changed'; timestamp: string; taskId?: string; data?: Record<string, unknown> };
