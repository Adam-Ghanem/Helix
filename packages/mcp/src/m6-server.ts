import { ToolRegistry } from '../../tools/src/index.js';
import { AgentRegistry } from '../../agents/src/index.js';
import { AgentScheduler } from '../../scheduler/src/index.js';
import { WorkerPool } from '../../workers/src/index.js';
import { SwarmOrchestrator } from '../../swarm/src/m4-swarm.js';

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; }

export interface McpRequest { method: string; params?: Record<string, unknown>; }
export interface McpResponse { result?: unknown; error?: { code: number; message: string }; }

export function createHelixMcpTools(context: {
  agents: AgentRegistry;
  scheduler: AgentScheduler;
  workers: WorkerPool;
  swarms?: SwarmOrchestrator;
}): McpTool[] {
  return [
    { name: 'helix.agent.list', description: 'List registered agents', inputSchema: { type: 'object' } },
    { name: 'helix.agent.status', description: 'Inspect an agent', inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] } },
    { name: 'helix.scheduler.tick', description: 'Run one scheduler tick', inputSchema: { type: 'object' } },
    { name: 'helix.scheduler.status', description: 'Inspect scheduler metrics', inputSchema: { type: 'object' } },
    { name: 'helix.worker.runOnce', description: 'Execute assigned work once', inputSchema: { type: 'object' } },
    { name: 'helix.worker.drain', description: 'Drain worker assignments', inputSchema: { type: 'object' } },
    { name: 'helix.swarm.status', description: 'Inspect swarm state', inputSchema: { type: 'object' } },
  ];
}

export function createMcpHandler(context: {
  agents: AgentRegistry;
  scheduler: AgentScheduler;
  workers: WorkerPool;
  swarms?: SwarmOrchestrator;
}): (request: McpRequest) => Promise<McpResponse> {
  return async (request) => {
    try {
      switch (request.method) {
        case 'helix.agent.list': return { result: context.agents.list() };
        case 'helix.agent.status': return { result: context.agents.get(String(request.params?.agentId)) };
        case 'helix.scheduler.tick': return { result: context.scheduler.tick() };
        case 'helix.scheduler.status': return { result: context.scheduler.metrics() };
        case 'helix.worker.runOnce': return { result: await context.workers.runOnce() };
        case 'helix.worker.drain': return { result: await context.workers.drain() };
        case 'helix.swarm.status': return { result: context.swarms?.status() ?? null };
        default: return { error: { code: -32601, message: `Unknown Helix MCP method: ${request.method}` } };
      }
    } catch (error) {
      return { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
  };
}
