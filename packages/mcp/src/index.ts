import { PublicToolDefinition, ToolRegistry, ToolSchema } from '../../tools/src/index.js';

export interface McpToolManifest { name: string; description: string; inputSchema: ToolSchema; risk?: 'low' | 'medium' | 'high'; permissions?: string[]; }
export interface McpServerDescriptor { id: string; endpoint: string; transport: 'stdio' | 'sse' | 'streamable-http'; trust: 'untrusted' | 'reviewed' | 'trusted'; }

export class McpGateway {
  private readonly servers = new Map<string, McpServerDescriptor>();
  constructor(private readonly registry: ToolRegistry) {}
  registerServer(server: McpServerDescriptor): void { if (!/^https?:\/\//.test(server.endpoint) && server.transport !== 'stdio') throw new Error('MCP network endpoint must use http(s)'); this.servers.set(server.id, { ...server }); }
  importManifest(serverId: string, tools: McpToolManifest[]): PublicToolDefinition[] { const server = this.servers.get(serverId); if (!server) throw new Error(`Unknown MCP server: ${serverId}`); return tools.map((tool) => this.registry.register({ name: `mcp.${server.id}.${tool.name}`, description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk ?? (server.trust === 'trusted' ? 'medium' : 'high'), permissions: tool.permissions ?? [`mcp:${server.id}`], source: 'mcp' })); }
  listServers(): McpServerDescriptor[] { return [...this.servers.values()].map((server) => ({ ...server })); }
  assertExecutionBoundary(toolName: string): void { if (!toolName.startsWith('mcp.')) throw new Error('MCP gateway can only mediate namespaced MCP tools'); const parts = toolName.split('.'); if (parts.length < 3 || !this.servers.has(parts[1]!)) throw new Error(`MCP tool is not registered: ${toolName}`); }
}

export * from './m6-server.js';
