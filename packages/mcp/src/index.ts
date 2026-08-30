import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PublicToolDefinition, ToolRegistry, ToolSchema } from '../../tools/src/index.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_PAGINATION_PAGES = 100;
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';

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

export type McpCacheScope = 'public' | 'private';

export interface McpCachePolicy {
  ttlMs: number;
  cacheScope: McpCacheScope;
}

export interface McpRemoteResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  [key: string]: unknown;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

export interface McpResourcesResult {
  resources: McpRemoteResource[];
  cache?: McpCachePolicy;
}

export interface McpResourceTemplatesResult {
  resourceTemplates: McpResourceTemplate[];
  cache?: McpCachePolicy;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
  cache?: McpCachePolicy;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpRemotePrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
  [key: string]: unknown;
}

export interface McpPromptsResult {
  prompts: McpRemotePrompt[];
  cache?: McpCachePolicy;
}

export interface McpPromptMessage {
  role: string;
  content: Record<string, unknown>;
}

export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
  [key: string]: unknown;
}

export interface McpSubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

export type McpSubscriptionEvent =
  | { type: 'tools-list-changed' }
  | { type: 'prompts-list-changed' }
  | { type: 'resources-list-changed' }
  | { type: 'resource-updated'; uri: string };

export type McpSubscriptionCloseReason = 'local' | 'graceful' | 'remote';

export interface McpSubscription {
  readonly id: string | number;
  readonly honoredFilter: McpSubscriptionFilter;
  readonly closed: Promise<McpSubscriptionCloseReason>;
  close(): Promise<void>;
}

export type McpSubscriptionListener = (event: McpSubscriptionEvent) => void | Promise<void>;

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
  listen(filter: McpSubscriptionFilter, listener: McpSubscriptionListener): Promise<McpSubscription>;
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
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
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
      const next = parseNextCursor(candidate.nextCursor, 'tools/list');
      if (!next) return tools;
      if (seen.has(next)) throw new Error(`MCP server ${this.server.id} repeated a tools/list cursor`);
      seen.add(next);
      cursor = next;
    }
    throw new Error(`MCP server ${this.server.id} exceeded the tools/list pagination limit`);
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!name) throw new Error('MCP tool name is required');
    const result = await this.transport.request('tools/call', { name, arguments: structuredClone(input) });
    if (!result || typeof result !== 'object') throw new Error(`MCP tool ${name} returned an invalid result`);
    return structuredClone(result as McpToolCallResult);
  }

  async listResources(): Promise<McpResourcesResult> {
    const resources: McpRemoteResource[] = [];
    let cursor: string | undefined;
    let cache: McpCachePolicy | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
      const result = await this.transport.request('resources/list', cursor ? { cursor } : {});
      const candidate = requireObjectResult(result, this.server.id, 'resources/list');
      if (!Array.isArray(candidate.resources)) throw new Error(`MCP server ${this.server.id} returned no resources array`);
      resources.push(...candidate.resources.map((resource, index) => parseResource(resource, this.server.id, index)));
      const pageCache = parseCachePolicy(candidate, this.server.id, 'resources/list');
      if (pageCache) cache = pageCache;
      const next = parseNextCursor(candidate.nextCursor, 'resources/list');
      if (!next) return { resources, ...(cache ? { cache } : {}) };
      if (seen.has(next)) throw new Error(`MCP server ${this.server.id} repeated a resources/list cursor`);
      seen.add(next);
      cursor = next;
    }
    throw new Error(`MCP server ${this.server.id} exceeded the resources/list pagination limit`);
  }

  async listResourceTemplates(): Promise<McpResourceTemplatesResult> {
    const resourceTemplates: McpResourceTemplate[] = [];
    let cursor: string | undefined;
    let cache: McpCachePolicy | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
      const result = await this.transport.request('resources/templates/list', cursor ? { cursor } : {});
      const candidate = requireObjectResult(result, this.server.id, 'resources/templates/list');
      if (!Array.isArray(candidate.resourceTemplates)) throw new Error(`MCP server ${this.server.id} returned no resourceTemplates array`);
      resourceTemplates.push(...candidate.resourceTemplates.map((template, index) => parseResourceTemplate(template, this.server.id, index)));
      const pageCache = parseCachePolicy(candidate, this.server.id, 'resources/templates/list');
      if (pageCache) cache = pageCache;
      const next = parseNextCursor(candidate.nextCursor, 'resources/templates/list');
      if (!next) return { resourceTemplates, ...(cache ? { cache } : {}) };
      if (seen.has(next)) throw new Error(`MCP server ${this.server.id} repeated a resources/templates/list cursor`);
      seen.add(next);
      cursor = next;
    }
    throw new Error(`MCP server ${this.server.id} exceeded the resources/templates/list pagination limit`);
  }

  async readResource(uri: string): Promise<McpReadResourceResult> {
    if (!uri.trim()) throw new Error('MCP resource URI is required');
    const result = await this.transport.request('resources/read', { uri });
    const candidate = requireObjectResult(result, this.server.id, 'resources/read');
    if (!Array.isArray(candidate.contents)) throw new Error(`MCP server ${this.server.id} returned no resource contents array`);
    const contents = candidate.contents.map((content, index) => parseResourceContent(content, this.server.id, index));
    const cache = parseCachePolicy(candidate, this.server.id, 'resources/read');
    return { contents, ...(cache ? { cache } : {}) };
  }

  async listPrompts(): Promise<McpPromptsResult> {
    const prompts: McpRemotePrompt[] = [];
    let cursor: string | undefined;
    let cache: McpCachePolicy | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
      const result = await this.transport.request('prompts/list', cursor ? { cursor } : {});
      const candidate = requireObjectResult(result, this.server.id, 'prompts/list');
      if (!Array.isArray(candidate.prompts)) throw new Error(`MCP server ${this.server.id} returned no prompts array`);
      prompts.push(...candidate.prompts.map((prompt, index) => parsePrompt(prompt, this.server.id, index)));
      const pageCache = parseCachePolicy(candidate, this.server.id, 'prompts/list');
      if (pageCache) cache = pageCache;
      const next = parseNextCursor(candidate.nextCursor, 'prompts/list');
      if (!next) return { prompts, ...(cache ? { cache } : {}) };
      if (seen.has(next)) throw new Error(`MCP server ${this.server.id} repeated a prompts/list cursor`);
      seen.add(next);
      cursor = next;
    }
    throw new Error(`MCP server ${this.server.id} exceeded the prompts/list pagination limit`);
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpGetPromptResult> {
    if (!name.trim()) throw new Error('MCP prompt name is required');
    const result = await this.transport.request('prompts/get', { name, arguments: structuredClone(args) });
    const candidate = requireObjectResult(result, this.server.id, 'prompts/get');
    if (!Array.isArray(candidate.messages)) throw new Error(`MCP server ${this.server.id} returned no prompt messages array`);
    const messages = candidate.messages.map((message, index) => parsePromptMessage(message, this.server.id, index));
    return {
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      messages,
    };
  }

  listen(filter: McpSubscriptionFilter, listener: McpSubscriptionListener = () => undefined): Promise<McpSubscription> {
    const validated = validateSubscriptionFilter(filter);
    return this.transport.listen(validated, listener);
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

  async listResources(serverId: string): Promise<McpResourcesResult> {
    this.requireServer(serverId);
    return this.client(serverId).listResources();
  }

  async listResourceTemplates(serverId: string): Promise<McpResourceTemplatesResult> {
    this.requireServer(serverId);
    return this.client(serverId).listResourceTemplates();
  }

  async readResource(serverId: string, uri: string): Promise<McpReadResourceResult> {
    this.requireServer(serverId);
    return this.client(serverId).readResource(uri);
  }

  async listPrompts(serverId: string): Promise<McpPromptsResult> {
    this.requireServer(serverId);
    return this.client(serverId).listPrompts();
  }

  async getPrompt(serverId: string, name: string, args: Record<string, string> = {}): Promise<McpGetPromptResult> {
    this.requireServer(serverId);
    return this.client(serverId).getPrompt(name, args);
  }

  listen(serverId: string, filter: McpSubscriptionFilter, listener: McpSubscriptionListener = () => undefined): Promise<McpSubscription> {
    this.requireServer(serverId);
    return this.client(serverId).listen(filter, listener);
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
  private readonly subscriptions = new Set<McpSubscription>();

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
        headers: this.headers(method, name),
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

  async listen(filter: McpSubscriptionFilter, listener: McpSubscriptionListener): Promise<McpSubscription> {
    const id = `listen-${this.nextId++}`;
    const controller = new AbortController();
    const params = withRequestMeta({ notifications: structuredClone(filter) }, this.protocolVersion);
    const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params });
    if (Buffer.byteLength(body) > this.maxMessageBytes) throw new Error(`MCP subscription request exceeds ${this.maxMessageBytes} bytes`);

    const response = await fetch(this.server.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: this.headers('subscriptions/listen'),
      body,
    });
    if (!response.ok) {
      controller.abort();
      throw new Error(`MCP subscriptions/listen failed with HTTP ${response.status}`);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      controller.abort();
      throw new Error('MCP subscriptions/listen requires a text/event-stream response');
    }
    if (!response.body) {
      controller.abort();
      throw new Error('MCP subscriptions/listen returned no response body');
    }

    let acked = false;
    let honoredFilter: McpSubscriptionFilter | undefined;
    let localClose = false;
    let settled = false;
    let resolveClosed!: (reason: McpSubscriptionCloseReason) => void;
    const closed = new Promise<McpSubscriptionCloseReason>((resolve) => { resolveClosed = resolve; });
    let resolveAck!: (honored: McpSubscriptionFilter) => void;
    let rejectAck!: (error: Error) => void;
    const acknowledged = new Promise<McpSubscriptionFilter>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });

    const settle = (reason: McpSubscriptionCloseReason): void => {
      if (settled) return;
      settled = true;
      resolveClosed(reason);
    };

    const processFrame = async (frame: unknown): Promise<void> => {
      if (!frame || typeof frame !== 'object') throw new Error(`MCP subscription ${id} received a non-object frame`);
      const message = frame as Record<string, unknown>;
      if (message.id === id) {
        if (message.error && typeof message.error === 'object') {
          const error = message.error as { code?: unknown; message?: unknown; data?: unknown };
          const protocolError = new McpProtocolError(typeof error.message === 'string' ? error.message : 'MCP subscription failed', typeof error.code === 'number' ? error.code : undefined, error.data);
          if (!acked) rejectAck(protocolError);
          settle('remote');
          return;
        }
        if ('result' in message) {
          if (!acked) rejectAck(new Error(`MCP subscription ${id} ended before acknowledgment`));
          settle('graceful');
          return;
        }
      }
      if (typeof message.method !== 'string') return;
      const notificationParams = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params as Record<string, unknown> : {};
      const subscriptionId = subscriptionIdFromParams(notificationParams);
      if (subscriptionId !== id) throw new Error(`MCP subscription ${id} received a frame with a mismatched subscription id`);
      if (message.method === 'notifications/subscriptions/acknowledged') {
        if (acked) return;
        const rawNotifications = notificationParams.notifications;
        if (!rawNotifications || typeof rawNotifications !== 'object' || Array.isArray(rawNotifications)) throw new Error(`MCP subscription ${id} acknowledgment has no notifications filter`);
        const honored = validateSubscriptionFilter(rawNotifications as McpSubscriptionFilter);
        if (!isSubscriptionSubset(filter, honored)) throw new Error(`MCP subscription ${id} acknowledgment exceeds the requested filter`);
        acked = true;
        honoredFilter = honored;
        resolveAck(structuredClone(honored));
        return;
      }
      if (!acked || !honoredFilter) throw new Error(`MCP subscription ${id} received a change notification before acknowledgment`);
      const event = parseSubscriptionEvent(message.method, notificationParams);
      if (!event || !subscriptionEventMatches(honoredFilter, event)) return;
      try {
        await listener(structuredClone(event));
      } catch {
        // Consumer callback failures do not tear down a healthy protocol stream.
      }
    };

    const pump = async (): Promise<void> => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (!acked) rejectAck(new Error(`MCP subscription ${id} ended before acknowledgment`));
            if (!settled) settle('remote');
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          if (Buffer.byteLength(buffer) > this.maxMessageBytes * 2) throw new Error(`MCP subscription buffer exceeds ${this.maxMessageBytes * 2} bytes`);
          buffer = buffer.replaceAll('\r\n', '\n');
          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary < 0) break;
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = sseData(block);
            if (!data || data === '[DONE]') continue;
            if (Buffer.byteLength(data) > this.maxMessageBytes) throw new Error(`MCP subscription frame exceeds ${this.maxMessageBytes} bytes`);
            await processFrame(JSON.parse(data) as unknown);
          }
        }
      } catch (error) {
        if (localClose) return;
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!acked) rejectAck(normalized);
        settle('remote');
      }
    };
    void pump();

    const ackTimer = setTimeout(() => {
      if (acked || settled) return;
      controller.abort();
      rejectAck(new Error(`MCP subscription acknowledgment timed out after ${this.timeoutMs}ms`));
      settle('remote');
    }, this.timeoutMs);

    let honored: McpSubscriptionFilter;
    try {
      honored = await acknowledged;
    } finally {
      clearTimeout(ackTimer);
    }

    const subscription: McpSubscription = {
      id,
      honoredFilter: structuredClone(honored),
      closed,
      close: async () => {
        if (settled) return;
        localClose = true;
        settle('local');
        controller.abort();
        try {
          await this.sendNotification('notifications/cancelled', { requestId: id, reason: 'Client closed MCP subscription' });
        } catch {
          // The local close reason remains authoritative if cancellation delivery races with peer shutdown.
        }
      },
    };
    this.subscriptions.add(subscription);
    void closed.then(() => this.subscriptions.delete(subscription));
    return subscription;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.subscriptions].map((subscription) => subscription.close()));
    this.subscriptions.clear();
  }

  private async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params: withRequestMeta(params, this.protocolVersion) });
    if (Buffer.byteLength(body) > this.maxMessageBytes) throw new Error(`MCP notification exceeds ${this.maxMessageBytes} bytes`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.server.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: this.headers(method, routingName(params)),
        body,
      });
      if (!response.ok) throw new Error(`MCP notification ${method} failed with HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(`MCP notification timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(method: string, name?: string): Record<string, string> {
    return {
      ...(this.server.headers ?? {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
    };
  }
}

interface StdioSubscriptionState {
  id: number;
  requestedFilter: McpSubscriptionFilter;
  honoredFilter?: McpSubscriptionFilter;
  listener: McpSubscriptionListener;
  acked: boolean;
  settled: boolean;
  resolveAck: (filter: McpSubscriptionFilter) => void;
  rejectAck: (error: Error) => void;
  resolveClosed: (reason: McpSubscriptionCloseReason) => void;
  closed: Promise<McpSubscriptionCloseReason>;
  ackTimer: NodeJS.Timeout;
}

class StdioMcpTransport implements McpTransport {
  private nextId = 1;
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private stdoutBuffer = '';
  private stderrTail = '';
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly subscriptions = new Map<number, StdioSubscriptionState>();
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

  async listen(filter: McpSubscriptionFilter, listener: McpSubscriptionListener): Promise<McpSubscription> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error(`MCP stdio server ${this.server.id} is not running`);
    const id = this.nextId++;
    let resolveAck!: (filter: McpSubscriptionFilter) => void;
    let rejectAck!: (error: Error) => void;
    const acknowledged = new Promise<McpSubscriptionFilter>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
    let resolveClosed!: (reason: McpSubscriptionCloseReason) => void;
    const closed = new Promise<McpSubscriptionCloseReason>((resolve) => { resolveClosed = resolve; });
    const ackTimer = setTimeout(() => {
      this.failSubscription(id, new Error(`MCP subscription acknowledgment timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    const state: StdioSubscriptionState = {
      id,
      requestedFilter: structuredClone(filter),
      listener,
      acked: false,
      settled: false,
      resolveAck,
      rejectAck,
      resolveClosed,
      closed,
      ackTimer,
    };
    this.subscriptions.set(id, state);
    const message = JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: withRequestMeta({ notifications: structuredClone(filter) }, this.protocolVersion) });
    if (Buffer.byteLength(message) > this.maxMessageBytes) {
      this.failSubscription(id, new Error(`MCP subscription request exceeds ${this.maxMessageBytes} bytes`));
      return acknowledged.then(() => { throw new Error('unreachable'); });
    }
    child.stdin.write(`${message}\n`, 'utf8', (error) => {
      if (error) this.failSubscription(id, error);
    });
    const honoredFilter = await acknowledged;
    return {
      id,
      honoredFilter: structuredClone(honoredFilter),
      closed,
      close: async () => this.closeSubscription(id),
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.subscriptions.keys()].map((id) => this.closeSubscription(id)));
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
      if (isJsonRpcNotification(message)) {
        this.handleSubscriptionNotification(message.method, message.params);
        continue;
      }
      if (!isJsonRpcResponse(message) || typeof message.id !== 'number') continue;
      const subscription = this.subscriptions.get(message.id);
      if (subscription) {
        if (message.error) {
          this.failSubscription(message.id, new McpProtocolError(message.error.message, message.error.code, message.error.data));
        } else if ('result' in message) {
          if (!subscription.acked) subscription.rejectAck(new Error(`MCP subscription ${message.id} ended before acknowledgment`));
          this.settleSubscription(message.id, 'graceful');
        }
        continue;
      }
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

  private handleSubscriptionNotification(method: string, params: Record<string, unknown>): void {
    const id = subscriptionIdFromParams(params);
    if (typeof id !== 'number') return;
    const state = this.subscriptions.get(id);
    if (!state) return;
    try {
      if (method === 'notifications/subscriptions/acknowledged') {
        if (state.acked) return;
        const rawNotifications = params.notifications;
        if (!rawNotifications || typeof rawNotifications !== 'object' || Array.isArray(rawNotifications)) throw new Error(`MCP subscription ${id} acknowledgment has no notifications filter`);
        const honored = validateSubscriptionFilter(rawNotifications as McpSubscriptionFilter);
        if (!isSubscriptionSubset(state.requestedFilter, honored)) throw new Error(`MCP subscription ${id} acknowledgment exceeds the requested filter`);
        state.acked = true;
        state.honoredFilter = honored;
        clearTimeout(state.ackTimer);
        state.resolveAck(structuredClone(honored));
        return;
      }
      if (!state.acked || !state.honoredFilter) throw new Error(`MCP subscription ${id} received a change notification before acknowledgment`);
      const event = parseSubscriptionEvent(method, params);
      if (!event || !subscriptionEventMatches(state.honoredFilter, event)) return;
      Promise.resolve(state.listener(structuredClone(event))).catch(() => undefined);
    } catch (error) {
      this.failSubscription(id, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async closeSubscription(id: number): Promise<void> {
    const state = this.subscriptions.get(id);
    if (!state || state.settled) return;
    this.settleSubscription(id, 'local');
    try {
      await this.sendNotification('notifications/cancelled', { requestId: id, reason: 'Client closed MCP subscription' });
    } catch {
      // The local close reason is authoritative even if the peer disappears during cancellation delivery.
    }
  }

  private async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error(`MCP stdio server ${this.server.id} is not running`);
    const message = JSON.stringify({ jsonrpc: '2.0', method, params: withRequestMeta(params, this.protocolVersion) });
    if (Buffer.byteLength(message) > this.maxMessageBytes) throw new Error(`MCP notification exceeds ${this.maxMessageBytes} bytes`);
    await new Promise<void>((resolve, reject) => child.stdin.write(`${message}\n`, 'utf8', (error) => error ? reject(error) : resolve()));
  }

  private settleSubscription(id: number, reason: McpSubscriptionCloseReason): void {
    const state = this.subscriptions.get(id);
    if (!state || state.settled) return;
    state.settled = true;
    clearTimeout(state.ackTimer);
    state.resolveClosed(reason);
    this.subscriptions.delete(id);
  }

  private failSubscription(id: number, error: Error): void {
    const state = this.subscriptions.get(id);
    if (!state) return;
    clearTimeout(state.ackTimer);
    if (!state.acked) state.rejectAck(error);
    if (!state.settled) {
      state.settled = true;
      state.resolveClosed('remote');
    }
    this.subscriptions.delete(id);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const id of [...this.subscriptions.keys()]) this.failSubscription(id, error);
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

function requireObjectResult(result: unknown, serverId: string, method: string): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`MCP server ${serverId} returned an invalid ${method} result`);
  return result as Record<string, unknown>;
}

function parseNextCursor(value: unknown, method: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`MCP ${method} nextCursor must be a string`);
  return value;
}

function parseCachePolicy(candidate: Record<string, unknown>, serverId: string, method: string): McpCachePolicy | undefined {
  const hasTtl = candidate.ttlMs !== undefined;
  const hasScope = candidate.cacheScope !== undefined;
  if (!hasTtl && !hasScope) return undefined;
  if (!hasTtl || !hasScope) throw new Error(`MCP server ${serverId} returned incomplete cache hints for ${method}`);
  if (typeof candidate.ttlMs !== 'number' || !Number.isInteger(candidate.ttlMs) || candidate.ttlMs < 0) throw new Error(`MCP server ${serverId} returned invalid cache ttlMs for ${method}`);
  if (candidate.cacheScope !== 'public' && candidate.cacheScope !== 'private') throw new Error(`MCP server ${serverId} returned invalid cacheScope for ${method}`);
  return { ttlMs: candidate.ttlMs, cacheScope: candidate.cacheScope };
}

function parseResource(value: unknown, serverId: string, index: number): McpRemoteResource {
  const resource = requireDefinition(value, serverId, `resource ${index}`);
  if (typeof resource.uri !== 'string' || !resource.uri.trim()) throw new Error(`MCP server ${serverId} returned a resource without a URI`);
  if (resource.name !== undefined && typeof resource.name !== 'string') throw new Error(`MCP resource ${resource.uri} has an invalid name`);
  if (resource.description !== undefined && typeof resource.description !== 'string') throw new Error(`MCP resource ${resource.uri} has an invalid description`);
  if (resource.mimeType !== undefined && typeof resource.mimeType !== 'string') throw new Error(`MCP resource ${resource.uri} has an invalid mimeType`);
  if (resource.size !== undefined && (typeof resource.size !== 'number' || !Number.isFinite(resource.size) || resource.size < 0)) throw new Error(`MCP resource ${resource.uri} has an invalid size`);
  return structuredClone(resource) as McpRemoteResource;
}

function parseResourceTemplate(value: unknown, serverId: string, index: number): McpResourceTemplate {
  const template = requireDefinition(value, serverId, `resource template ${index}`);
  if (typeof template.uriTemplate !== 'string' || !template.uriTemplate.trim()) throw new Error(`MCP server ${serverId} returned a resource template without uriTemplate`);
  if (template.name !== undefined && typeof template.name !== 'string') throw new Error(`MCP resource template ${template.uriTemplate} has an invalid name`);
  if (template.description !== undefined && typeof template.description !== 'string') throw new Error(`MCP resource template ${template.uriTemplate} has an invalid description`);
  if (template.mimeType !== undefined && typeof template.mimeType !== 'string') throw new Error(`MCP resource template ${template.uriTemplate} has an invalid mimeType`);
  return structuredClone(template) as McpResourceTemplate;
}

function parseResourceContent(value: unknown, serverId: string, index: number): McpResourceContent {
  const content = requireDefinition(value, serverId, `resource content ${index}`);
  if (typeof content.uri !== 'string' || !content.uri.trim()) throw new Error(`MCP server ${serverId} returned resource content without a URI`);
  if (content.mimeType !== undefined && typeof content.mimeType !== 'string') throw new Error(`MCP resource content ${content.uri} has an invalid mimeType`);
  if (content.text !== undefined && typeof content.text !== 'string') throw new Error(`MCP resource content ${content.uri} has invalid text`);
  if (content.blob !== undefined && typeof content.blob !== 'string') throw new Error(`MCP resource content ${content.uri} has an invalid blob`);
  if (content.text === undefined && content.blob === undefined) throw new Error(`MCP resource content ${content.uri} has neither text nor blob data`);
  return structuredClone(content) as McpResourceContent;
}

function parsePrompt(value: unknown, serverId: string, index: number): McpRemotePrompt {
  const prompt = requireDefinition(value, serverId, `prompt ${index}`);
  if (typeof prompt.name !== 'string' || !prompt.name.trim()) throw new Error(`MCP server ${serverId} returned a prompt without a name`);
  if (prompt.description !== undefined && typeof prompt.description !== 'string') throw new Error(`MCP prompt ${prompt.name} has an invalid description`);
  if (prompt.arguments !== undefined) {
    if (!Array.isArray(prompt.arguments)) throw new Error(`MCP prompt ${prompt.name} has invalid arguments`);
    prompt.arguments = prompt.arguments.map((argument, argumentIndex) => parsePromptArgument(argument, serverId, prompt.name as string, argumentIndex));
  }
  return structuredClone(prompt) as McpRemotePrompt;
}

function parsePromptArgument(value: unknown, serverId: string, promptName: string, index: number): McpPromptArgument {
  const argument = requireDefinition(value, serverId, `prompt argument ${index}`);
  if (typeof argument.name !== 'string' || !argument.name.trim()) throw new Error(`MCP prompt ${promptName} returned an argument without a name`);
  if (argument.description !== undefined && typeof argument.description !== 'string') throw new Error(`MCP prompt ${promptName} has an invalid argument description`);
  if (argument.required !== undefined && typeof argument.required !== 'boolean') throw new Error(`MCP prompt ${promptName} has an invalid required flag`);
  return {
    name: argument.name,
    ...(typeof argument.description === 'string' ? { description: argument.description } : {}),
    ...(typeof argument.required === 'boolean' ? { required: argument.required } : {}),
  };
}

function parsePromptMessage(value: unknown, serverId: string, index: number): McpPromptMessage {
  const message = requireDefinition(value, serverId, `prompt message ${index}`);
  if (typeof message.role !== 'string' || !message.role.trim()) throw new Error(`MCP server ${serverId} returned a prompt message without a role`);
  if (!message.content || typeof message.content !== 'object' || Array.isArray(message.content)) throw new Error(`MCP server ${serverId} returned invalid prompt message content`);
  const content = message.content as Record<string, unknown>;
  if (typeof content.type !== 'string' || !content.type) throw new Error(`MCP server ${serverId} returned prompt content without a type`);
  if (content.type === 'text' && typeof content.text !== 'string') throw new Error(`MCP server ${serverId} returned invalid prompt text content`);
  return { role: message.role, content: structuredClone(content) };
}

function requireDefinition(value: unknown, serverId: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MCP server ${serverId} returned invalid ${label}`);
  return value as Record<string, unknown>;
}

function validateSubscriptionFilter(filter: McpSubscriptionFilter): McpSubscriptionFilter {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('MCP subscription filter must be an object');
  const validated: McpSubscriptionFilter = {};
  for (const key of ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged'] as const) {
    const value = filter[key];
    if (value !== undefined && typeof value !== 'boolean') throw new Error(`MCP subscription ${key} must be boolean`);
    if (value === true) validated[key] = true;
  }
  if (filter.resourceSubscriptions !== undefined) {
    if (!Array.isArray(filter.resourceSubscriptions) || !filter.resourceSubscriptions.every((uri) => typeof uri === 'string' && uri.trim())) throw new Error('MCP subscription resourceSubscriptions must contain non-empty URIs');
    const uris = [...new Set(filter.resourceSubscriptions)];
    if (uris.length) validated.resourceSubscriptions = uris;
  }
  if (!validated.toolsListChanged && !validated.promptsListChanged && !validated.resourcesListChanged && !validated.resourceSubscriptions?.length) throw new Error('MCP subscription filter must request at least one notification type');
  return validated;
}

function isSubscriptionSubset(requested: McpSubscriptionFilter, honored: McpSubscriptionFilter): boolean {
  if (honored.toolsListChanged && !requested.toolsListChanged) return false;
  if (honored.promptsListChanged && !requested.promptsListChanged) return false;
  if (honored.resourcesListChanged && !requested.resourcesListChanged) return false;
  const requestedUris = new Set(requested.resourceSubscriptions ?? []);
  return (honored.resourceSubscriptions ?? []).every((uri) => requestedUris.has(uri));
}

function subscriptionIdFromParams(params: Record<string, unknown>): string | number | undefined {
  const meta = params._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const id = (meta as Record<string, unknown>)[SUBSCRIPTION_ID_META_KEY];
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function parseSubscriptionEvent(method: string, params: Record<string, unknown>): McpSubscriptionEvent | undefined {
  if (method === 'notifications/tools/list_changed') return { type: 'tools-list-changed' };
  if (method === 'notifications/prompts/list_changed') return { type: 'prompts-list-changed' };
  if (method === 'notifications/resources/list_changed') return { type: 'resources-list-changed' };
  if (method === 'notifications/resources/updated') {
    if (typeof params.uri !== 'string' || !params.uri.trim()) throw new Error('MCP resources/updated notification requires a URI');
    return { type: 'resource-updated', uri: params.uri };
  }
  return undefined;
}

function subscriptionEventMatches(filter: McpSubscriptionFilter, event: McpSubscriptionEvent): boolean {
  if (event.type === 'tools-list-changed') return filter.toolsListChanged === true;
  if (event.type === 'prompts-list-changed') return filter.promptsListChanged === true;
  if (event.type === 'resources-list-changed') return filter.resourcesListChanged === true;
  return filter.resourceSubscriptions?.includes(event.uri) ?? false;
}

function sseData(block: string): string {
  return block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
}

function isJsonRpcNotification(value: unknown): value is { jsonrpc: '2.0'; method: string; params: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  return candidate.jsonrpc === '2.0' && candidate.id === undefined && typeof candidate.method === 'string' && Boolean(candidate.params) && typeof candidate.params === 'object' && !Array.isArray(candidate.params);
}

function findJsonResponse(text: string, id: number): JsonRpcResponse | undefined {
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed.find((value) => isJsonRpcResponse(value) && value.id === id) as JsonRpcResponse | undefined;
  return isJsonRpcResponse(parsed) && parsed.id === id ? parsed : undefined;
}

function findSseResponse(text: string, id: number): JsonRpcResponse | undefined {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = sseData(block);
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