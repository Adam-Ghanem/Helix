import { PublicToolDefinition, ToolRegistry, ToolSchema } from '../../tools/src/index.js';

export interface McpToolManifest {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  risk?: 'low' | 'medium' | 'high';
  permissions?: string[];
}

export interface McpServerDescriptor {
  id: string;
  endpoint: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  trust: 'untrusted' | 'reviewed' | 'trusted';
}

export class McpGateway {
  private readonly servers = new Map<string, McpServerDescriptor>();

  constructor(private readonly registry: ToolRegistry) {}

  registerServer(server: McpServerDescriptor): void {
    if (!/^https?:\/\//.test(server.endpoint) && server.transport !== 'stdio') throw new Error('MCP network endpoint must use http(s)');
    this.servers.set(server.id, { ...server });
  }

  importManifest(serverId: string, tools: McpToolManifest[]): PublicToolDefinition[] {
    const server = this.servers.get(serverId);
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    return tools.map((tool) => this.registry.register({
      name: `mcp.${server.id}.${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      risk: tool.risk ?? (server.trust === 'trusted' ? 'medium' : 'high'),
      permissions: tool.permissions ?? [`mcp:${server.id}`],
      source: 'mcp',
    }));
  }

  listServers(): McpServerDescriptor[] {
    return [...this.servers.values()].map((server) => ({ ...server }));
  }

  assertExecutionBoundary(toolName: string): void {
    if (!toolName.startsWith('mcp.')) throw new Error('MCP gateway can only mediate namespaced MCP tools');
    const parts = toolName.split('.');
    if (parts.length < 3 || !this.servers.has(parts[1]!)) throw new Error(`MCP tool is not registered: ${toolName}`);
  }
}


export interface HelixMemoryToolHandlers {
  search(input: Record<string, unknown>): Promise<unknown>;
  get(input: Record<string, unknown>): Promise<unknown>;
  list(input: Record<string, unknown>): Promise<unknown>;
  stats(input: Record<string, unknown>): Promise<unknown>;
  recall(input: Record<string, unknown>): Promise<unknown>;
  routingHints(input: Record<string, unknown>): Promise<unknown>;
  agentExperience(input: Record<string, unknown>): Promise<unknown>;
}

export function registerHelixMemoryTools(registry: ToolRegistry, handlers: HelixMemoryToolHandlers): PublicToolDefinition[] {
  const common = { risk: 'low' as const, source: 'builtin' as const, permissions: ['memory:read'] };
  return [
    registry.register({ ...common, name: 'helix.memory.search', description: 'Search authorized Helix memory using transparent hybrid ranking', inputSchema: { required: ['query'], properties: { query: 'string', subject: 'string' } }, handler: handlers.search }),
    registry.register({ ...common, name: 'helix.memory.get', description: 'Read one authorized Helix memory entry', inputSchema: { required: ['id'], properties: { id: 'string', subject: 'string' } }, handler: handlers.get }),
    registry.register({ ...common, name: 'helix.memory.list', description: 'List authorized Helix memory entries', inputSchema: { properties: { subject: 'string' } }, handler: handlers.list }),
    registry.register({ ...common, name: 'helix.memory.stats', description: 'Report authorized Helix memory statistics', inputSchema: { properties: { subject: 'string' } }, handler: handlers.stats }),
    registry.register({ ...common, name: 'helix.learning.recall', description: 'Recall historical learning evidence for a task', inputSchema: { required: ['query'], properties: { query: 'string', subject: 'string' } }, handler: handlers.recall }),
    registry.register({ ...common, name: 'helix.learning.routingHints', description: 'Return bounded deterministic routing hints', inputSchema: { required: ['taskType'], properties: { taskType: 'string', capabilities: 'array', subject: 'string' } }, handler: handlers.routingHints }),
    registry.register({ ...common, name: 'helix.learning.agentExperience', description: 'Return historical experience for an agent', inputSchema: { required: ['agentId'], properties: { agentId: 'string' } }, handler: handlers.agentExperience }),
  ];
}
