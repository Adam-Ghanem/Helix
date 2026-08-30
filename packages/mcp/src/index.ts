import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PublicToolDefinition, ToolRegistry, ToolSchema } from '../../tools/src/index.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

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
  args?: string[];
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxMessageBytes?: number;
  protocolVersion?: string;
}

export interface McpDiscoveryResult {
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  instructions?: string;
  _meta?: Record<string, unknown>;
}

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content?: unknown[];
  isError?: boolean;
  [key: string]: unknown;
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export class McpProtocolError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

interface McpTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export class McpClient {
  private readonly transport: McpTransport;
  private discovery: McpDiscoveryResult | undefined;

  constructor(readonly server: McpServerDescriptor) {
    const protocolVersion = server.protocolVersion ?? MCP_PROTOCOL_VERSION;
    if (server.transport === 'streamable-http') {
      this.transport = new StreamableHttpMcpTransport(server, protocolVersion);
    } else if (server.transport === 'stdio') {
      if (server.trust === 'untrusted') throw new Error(`Refusing to spawn untrusted MCP stdio server: ${server.id}`);
      this.transport = new StdioMcpTransport(server, protocolVersion);
    } else {
      throw new Error('Legacy MCP HTTP+SSE transport is deprecated; use streamable-http');
    }
  }

  async discover(): Promise<McpDiscoveryResult> {
    if (this.discovery) return structuredClone(this.discovery);
    const result = await this.transport.request('server/discover', {});
    if (!result || typeof result !== 'object') throw new Error(`MCP server ${this.server.id} returned an invalid discover result`);
    const candidate = result as { supportedVersions?: unknown; capabilities?: unknown; instructions?: unknown; _meta?: unknown };
    if (!Array.isArray(candidate.supportedVersions) || !candidate.supportedVersions.every((value) => typeof value === 'string')) throw new Error(`MCP server ${this.server.id} returned no supported protocol versions`);
    if (!candidate.capabilities || typeof candidate.capabilities !== 'object') throw new Error(`MCP server ${this.server.id} returned invalid capabilities`);
    const protocolVersion = this.server.protocolVersion ?? MCP_PROTOCOL_VERSION;
    if (!candidate.supportedVersions.includes(protocolVersion)) throw new Error(`MCP server ${this.server.id} does not support protocol ${protocolVersion}`);
    this.discovery = {
      supportedVersions: [...candidate.supportedVersions],
      capabilities: structuredClone(candidate.capabilities as Record<string, unknown>),
      ...(typeof candidate.instructions === 'string' ? { instructions: candidate.instructions } : {}),
      ...(candidate._meta && typeof candidate._meta === 'object' ? { _meta: structuredClone(candidate._meta as Record<string, unknown>) } : {}),
    };
    return structuredClone(this.discovery);
  }

  async listTools(): Promise<McpRemoteTool[]> {
    const tools: McpRemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.transport.request('tools/list', cursor ? { cursor } : {});
      if (!result || typeof result !== 'object') throw new Error(`MCP server ${this.server.id} returned an invalid tools/list result`);
      const candidate = result as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(candidate.tools)) throw new Error(`MCP server ${this.server.id} returned no tools array`);
      for (const raw of candidate.tools) {
        if (!raw || typeof raw !== 'object') throw new Error(`MCP server ${this.server.id} returned an invalid tool definition`);
        const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof tool.name !== 'string' || !tool.name) throw new Error(`MCP server ${this.server.id} returned a tool without a name`);
        if (!tool.inputSchema || typeof tool.inputSchema !== 'object') throw new Error(`MCP tool ${tool.name} has no input schema`);
        tools.push({
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          inputSchema: structuredClone(tool.inputSchema as Record<string, unknown>),
        });
      }
      cursor = typeof candidate.nextCursor === 'string' && candidate.nextCursor ? candidate.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!name) throw new Error('MCP tool name is required');
    const result = await this.transport.request('tools/call', { name, arguments: structuredClone(input) });
    if (!result || typeof result !== 'object') throw new Error(`MCP tool ${name} returned an invalid result`);
    return structuredClone(result as McpToolCallResult);
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

export class McpGateway {
  private readonly servers = new Map<string, McpServerDescriptor>();
  private readonly clients = new Map<string, McpClient>();
  private readonly syncedTools = new Set<string>();

  constructor(private readonly registry: ToolRegistry) {}

  registerServer(server: McpServerDescriptor): void {
    if (!/^[A-Za-z0-9_-]+$/.test(server.id)) throw new Error('MCP server id may contain only letters, numbers, underscore, and hyphen');
    if (this.servers.has(server.id)) throw new Error(`MCP server already registered: ${server.id}`);
    if (server.transport === 'streamable-http' || server.transport === 'sse') {
      const endpoint = new URL(server.endpoint);
      if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('MCP network endpoint must use http(s)');
    } else if (!server.endpoint.trim()) {
      throw new Error('MCP stdio server requires an executable endpoint');
    }
    if (server.timeoutMs !== undefined && (!Number.isFinite(server.timeoutMs) || server.timeoutMs <= 0)) throw new Error('MCP timeout must be greater than zero');
    if (server.maxMessageBytes !== undefined && (!Number.isInteger(server.maxMessageBytes) || server.maxMessageBytes < 1024)) throw new Error('MCP maxMessageBytes must be at least 1024');
    this.servers.set(server.id, structuredClone(server));
  }

  importManifest(serverId: string, tools: McpToolManifest[]): PublicToolDefinition[] {
    const server = this.requireServer(serverId);
    return tools.map((tool) => this.registry.register({
      name: `mcp.${server.id}.${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      risk: tool.risk ?? riskForTrust(server.trust),
      permissions: tool.permissions ?? [`mcp:${server.id}`],
      source: 'mcp',
    }));
  }

  async discover(serverId: string): Promise<McpDiscoveryResult> {
    return this.client(serverId).discover();
  }

  async syncTools(serverId: string): Promise<PublicToolDefinition[]> {
    const server = this.requireServer(serverId);
    const client = this.client(serverId);
    await client.discover();
    const tools = await client.listTools();
    const registered: PublicToolDefinition[] = [];
    for (const tool of tools) {
      const localName = `mcp.${server.id}.${tool.name}`;
      if (this.syncedTools.has(localName)) continue;
      const remoteName = tool.name;
      registered.push(this.registry.register({
        name: localName,
        description: tool.description ?? `MCP tool ${remoteName} from ${server.id}`,
        inputSchema: toToolSchema(tool.inputSchema),
        risk: riskForTrust(server.trust),
        permissions: [`mcp:${server.id}`],
        source: 'mcp',
        handler: async (input) => client.callTool(remoteName, input),
      }));
      this.syncedTools.add(localName);
    }
    return registered;
  }

  async execute(serverId: string, toolName: string, input: Record<string, unknown>): Promise<McpToolCallResult> {
    this.requireServer(serverId);
    return this.client(serverId).callTool(toolName, input);
  }

  listServers(): McpServerDescriptor[] {
    return [...this.servers.values()].map((server) => structuredClone(server));
  }

  assertExecutionBoundary(toolName: string): void {
    if (!toolName.startsWith('mcp.')) throw new Error('MCP gateway can only mediate namespaced MCP tools');
    const parts = toolName.split('.');
    if (parts.length < 3 || !this.servers.has(parts[1]!)) throw new Error(`MCP tool is not registered: ${toolName}`);
  }

  async close(serverId?: string): Promise<void> {
    if (serverId) {
      const client = this.clients.get(serverId);
      if (client) await client.close();
      this.clients.delete(serverId);
      return;
    }
    await Promise.allSettled([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }

  private client(serverId: string): McpClient {
    const existing = this.clients.get(serverId);
    if (existing) return existing;
    const client = new McpClient(this.requireServer(serverId));
    this.clients.set(serverId, client);
    return client;
  }

  private requireServer(serverId: string): McpServerDescriptor {
    const server = this.servers.get(serverId);
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    return server;
  }
}

class StreamableHttpMcpTransport implements McpTransport {
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly maxMessageBytes: number;

  constructor(private readonly server: McpServerDescriptor, private readonly protocolVersion: string) {
    this.timeoutMs = server.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxMessageBytes = server.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    const bodyParams = withRequestMeta(params, this.protocolVersion);
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: bodyParams });
    if (Buffer.byteLength(body) > this.maxMessageBytes) throw new Error(`MCP request exceeds ${this.maxMessageBytes} bytes`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const name = routingName(params);
      const response = await fetch(this.server.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...(this.server.headers ?? {}),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': this.protocolVersion,
          'Mcp-Method': method,
          ...(name ? { 'Mcp-Name': name } : {}),
        },
        body,
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > this.maxMessageBytes) throw new Error(`MCP response exceeds ${this.maxMessageBytes} bytes`);
      const rpc = response.headers.get('content-type')?.includes('text/event-stream')
        ? findSseResponse(text, id)
        : findJsonResponse(text, id);
      if (!rpc) throw new Error(`MCP server ${this.server.id} returned no JSON-RPC response for request ${id}`);
      return unwrapJsonRpc(rpc, response.ok);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(`MCP request timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // Modern Streamable HTTP is stateless and has no session to close.
  }
}

class StdioMcpTransport implements McpTransport {
  private nextId = 1;
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private stdoutBuffer = '';
  private stderrTail = '';
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly timeoutMs: number;
  private readonly maxMessageBytes: number;

  constructor(private readonly server: McpServerDescriptor, private readonly protocolVersion: string) {
    this.timeoutMs = server.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxMessageBytes = server.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error(`MCP stdio server ${this.server.id} is not running`);
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params: withRequestMeta(params, this.protocolVersion) });
    if (Buffer.byteLength(message) > this.maxMessageBytes) throw new Error(`MCP request exceeds ${this.maxMessageBytes} bytes`);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${message}\n`, 'utf8', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    if (!child) return;
    this.failAll(new Error(`MCP stdio server ${this.server.id} closed`));
    child.stdin.end();
    if (!child.killed) child.kill('SIGTERM');
  }

  private start(): Promise<void> {
    if (this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(this.server.endpoint, this.server.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.server.environment ?? {}) },
        shell: false,
      });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_192);
      });
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        this.child = undefined;
        this.starting = undefined;
        this.failAll(error);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        this.child = undefined;
        this.starting = undefined;
        const suffix = this.stderrTail.trim() ? ` stderr: ${this.stderrTail.trim()}` : '';
        this.failAll(new Error(`MCP stdio server ${this.server.id} exited (${code ?? signal ?? 'unknown'})${suffix}`));
      });
    });
    return this.starting;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxMessageBytes * 2) {
      this.failAll(new Error(`MCP stdio buffer exceeds ${this.maxMessageBytes * 2} bytes`));
      this.child?.kill('SIGTERM');
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > this.maxMessageBytes) {
        this.failAll(new Error(`MCP stdio message exceeds ${this.maxMessageBytes} bytes`));
        this.child?.kill('SIGTERM');
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(new Error(`MCP stdio server ${this.server.id} wrote non-JSON data to stdout`));
        this.child?.kill('SIGTERM');
        return;
      }
      if (!isJsonRpcResponse(message) || typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      try {
        pending.resolve(unwrapJsonRpc(message, true));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function withRequestMeta(params: Record<string, unknown>, protocolVersion: string): Record<string, unknown> {
  const existingMeta = params._meta && typeof params._meta === 'object' ? params._meta as Record<string, unknown> : {};
  return {
    ...params,
    _meta: {
      ...existingMeta,
      'io.modelcontextprotocol/protocolVersion': protocolVersion,
      'io.modelcontextprotocol/clientInfo': { name: 'helix', version: '0.1.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
}

function routingName(params: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'uri', 'taskId']) {
    const value = params[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function findJsonResponse(text: string, id: number): JsonRpcResponse | undefined {
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed.find((value) => isJsonRpcResponse(value) && value.id === id) as JsonRpcResponse | undefined;
  return isJsonRpcResponse(parsed) && parsed.id === id ? parsed : undefined;
}

function findSseResponse(text: string, id: number): JsonRpcResponse | undefined {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    const parsed = JSON.parse(data) as unknown;
    if (isJsonRpcResponse(parsed) && parsed.id === id) return parsed;
  }
  return undefined;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
  return candidate.jsonrpc === '2.0' && ['string', 'number'].includes(typeof candidate.id) || (candidate.jsonrpc === '2.0' && candidate.id === null);
}

function unwrapJsonRpc(response: JsonRpcResponse, httpOk: boolean): unknown {
  if (response.error) throw new McpProtocolError(response.error.message, response.error.code, response.error.data);
  if (!httpOk) throw new McpProtocolError('MCP HTTP request failed without a protocol error');
  if (!('result' in response)) throw new McpProtocolError('MCP JSON-RPC response is missing result');
  return response.result;
}

function riskForTrust(trust: McpServerDescriptor['trust']): 'low' | 'medium' | 'high' {
  if (trust === 'trusted') return 'medium';
  return 'high';
}

function toToolSchema(inputSchema: Record<string, unknown>): ToolSchema {
  const schema: ToolSchema = {};
  if (Array.isArray(inputSchema.required)) {
    const required = inputSchema.required.filter((value): value is string => typeof value === 'string');
    if (required.length) schema.required = required;
  }
  if (inputSchema.properties && typeof inputSchema.properties === 'object') {
    const properties: NonNullable<ToolSchema['properties']> = {};
    for (const [name, raw] of Object.entries(inputSchema.properties as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const type = (raw as { type?: unknown }).type;
      if (type === 'string' || type === 'number' || type === 'boolean' || type === 'object' || type === 'array') properties[name] = type;
    }
    if (Object.keys(properties).length) schema.properties = properties;
  }
  return schema;
}
