import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DurableFederationState, FederationNodeHeartbeat, FederationResult, FederationTask } from './state.js';
import { FederationMessage, FederationRegistry } from './index.js';

export interface FederationExecutionOutcome {
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface FederationHeartbeatAck {
  nodeId: string;
  acceptedNodeId: string;
}

export interface FederationHttpServerOptions {
  nodeId: string;
  secret: string;
  state: DurableFederationState;
  execute: (task: FederationTask) => Promise<FederationExecutionOutcome>;
  maxBodyBytes?: number;
  resultTtlMs?: number;
}

export interface FederationHttpServerAddress {
  endpoint: string;
}

export class FederationHttpServer {
  private readonly nodeId: string;
  private readonly secret: string;
  private readonly state: DurableFederationState;
  private readonly executeTask: FederationHttpServerOptions['execute'];
  private readonly maxBodyBytes: number;
  private readonly resultTtlMs: number;
  private readonly registry = new FederationRegistry();
  private readonly server: Server;
  private readonly inFlight = new Map<string, Promise<FederationResult>>();

  constructor(options: FederationHttpServerOptions) {
    if (!options.nodeId.trim()) throw new Error('Federation HTTP server nodeId is required');
    if (!options.secret) throw new Error('Federation HTTP server secret is required');
    this.nodeId = options.nodeId;
    this.secret = options.secret;
    this.state = options.state;
    this.executeTask = options.execute;
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    this.resultTtlMs = options.resultTtlMs ?? 30_000;
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) throw new Error('Federation maxBodyBytes must be a positive integer');
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  async start(options: { host: string; port: number }): Promise<FederationHttpServerAddress> {
    await this.state.init();
    if (this.server.listening) throw new Error('Federation HTTP server is already listening');
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(options.port, options.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Federation HTTP server has no TCP address');
    const info = address as AddressInfo;
    const host = info.address === '::' ? '127.0.0.1' : info.address;
    return { endpoint: `http://${formatHost(host)}:${info.port}` };
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || !['/v1/federation/task', '/v1/federation/heartbeat'].includes(request.url ?? '')) {
      json(response, 404, { error: 'not-found' });
      return;
    }
    if (!String(request.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      json(response, 415, { error: 'content-type must be application/json' });
      return;
    }

    const body = await readBoundedBody(request, this.maxBodyBytes);
    if (body.tooLarge) {
      json(response, 413, { error: 'request body too large' });
      return;
    }

    if (request.url === '/v1/federation/heartbeat') {
      await this.handleHeartbeat(body.text, response);
      return;
    }
    await this.handleTask(body.text, response);
  }

  private async handleHeartbeat(body: string, response: ServerResponse): Promise<void> {
    let message: FederationMessage<{ kind: 'heartbeat'; node: FederationNodeHeartbeat }>;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!isHeartbeatMessage(parsed)) throw new Error('invalid federation heartbeat envelope');
      message = parsed;
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const acceptance = await this.state.acceptMessage(message);
    if (!acceptance.accepted) {
      json(response, acceptanceStatus(acceptance.reason), { error: acceptance.reason });
      return;
    }
    if (message.from !== message.payload.node.id) {
      json(response, 403, { error: 'heartbeat source does not match advertised node' });
      return;
    }

    const node = await this.state.heartbeatNode(message.payload.node);
    const payload = { kind: 'heartbeat-ack' as const, nodeId: this.nodeId, acceptedNodeId: node.id };
    json(response, 200, this.registry.sign(this.nodeId, message.from, payload, this.secret, this.resultTtlMs));
  }

  private async handleTask(body: string, response: ServerResponse): Promise<void> {
    let message: FederationMessage<{ kind: 'task'; task: FederationTask }>;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!isTaskMessage(parsed)) throw new Error('invalid federation task envelope');
      message = parsed;
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const acceptance = await this.state.acceptMessage(message);
    if (!acceptance.accepted) {
      json(response, acceptanceStatus(acceptance.reason), { error: acceptance.reason });
      return;
    }

    const task = message.payload.task;
    if (task.assignedNodeId && task.assignedNodeId !== this.nodeId) {
      json(response, 409, { error: 'task assigned to another node' });
      return;
    }

    const existing = await this.state.findResultForTask(task.id, task.leaseId ? task.attempt : undefined);
    const result = existing ?? await this.executeOnce(task);
    const signed = this.registry.sign(this.nodeId, message.from, { kind: 'result' as const, result }, this.secret, this.resultTtlMs);
    json(response, 200, signed);
  }

  private async executeOnce(task: FederationTask): Promise<FederationResult> {
    const key = task.leaseId ? `${task.id}:${task.leaseId}:${task.attempt}` : `${task.id}:legacy`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const promise = this.executeAndPersist(task).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async executeAndPersist(task: FederationTask): Promise<FederationResult> {
    const imported = await this.state.importTask(task);
    if (imported.executionId !== task.executionId) throw new Error(`Federation task ${task.id} conflicts with an existing execution`);
    const leased = Boolean(task.leaseId);
    const existing = await this.state.findResultForTask(task.id, leased ? task.attempt : undefined);
    if (existing) return existing;

    if (leased) {
      await this.state.updateTask(task.id, {
        status: 'running',
        attempt: task.attempt,
        assignedNodeId: this.nodeId,
        leaseId: task.leaseId!,
      });
    } else {
      await this.state.updateTask(task.id, { status: 'running', attempt: imported.attempt + 1, assignedNodeId: this.nodeId });
    }
    const executionTask = await this.state.getTask(task.id);
    if (!executionTask) throw new Error(`Federation task ${task.id} disappeared before execution`);

    let outcome: FederationExecutionOutcome;
    try {
      outcome = await this.executeTask(structuredClone(executionTask));
    } catch (error) {
      outcome = { success: false, error: error instanceof Error ? error.message : String(error) };
    }

    const result = await this.state.appendResult({
      taskId: executionTask.id,
      executionId: executionTask.executionId,
      nodeId: this.nodeId,
      attempt: executionTask.attempt,
      ...(executionTask.leaseId ? { leaseId: executionTask.leaseId } : {}),
      success: outcome.success,
      ...(outcome.output !== undefined ? { output: structuredClone(outcome.output) } : {}),
      ...(!outcome.success ? { error: outcome.error ?? 'Federation task failed' } : {}),
    });
    await this.state.updateTask(executionTask.id, {
      status: outcome.success ? 'completed' : 'failed',
      ...(!outcome.success ? { error: outcome.error ?? 'Federation task failed' } : {}),
    });
    return result;
  }
}

export interface FederationHttpClientOptions {
  nodeId: string;
  secret: string;
  state: DurableFederationState;
  timeoutMs?: number;
  messageTtlMs?: number;
}

export class FederationHttpClient {
  private readonly nodeId: string;
  private readonly secret: string;
  private readonly state: DurableFederationState;
  private readonly timeoutMs: number;
  private readonly messageTtlMs: number;
  private readonly registry = new FederationRegistry();

  constructor(options: FederationHttpClientOptions) {
    if (!options.nodeId.trim()) throw new Error('Federation HTTP client nodeId is required');
    if (!options.secret) throw new Error('Federation HTTP client secret is required');
    this.nodeId = options.nodeId;
    this.secret = options.secret;
    this.state = options.state;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.messageTtlMs = options.messageTtlMs ?? 30_000;
  }

  async sendHeartbeat(input: { endpoint: string; targetNodeId: string; node: FederationNodeHeartbeat }): Promise<FederationHeartbeatAck> {
    await this.state.init();
    if (!/^https?:\/\//.test(input.endpoint)) throw new Error('Federation endpoint must use http(s)');
    if (!input.targetNodeId.trim()) throw new Error('Federation heartbeat targetNodeId is required');
    if (input.node.id !== this.nodeId) throw new Error('Federation heartbeat node id must match the client nodeId');
    const envelope = this.registry.sign(this.nodeId, input.targetNodeId, { kind: 'heartbeat' as const, node: structuredClone(input.node) }, this.secret, this.messageTtlMs);
    const message = await this.postEnvelope(`${input.endpoint.replace(/\/$/, '')}/v1/federation/heartbeat`, envelope, isHeartbeatAckMessage, 'heartbeat acknowledgement');
    if (message.from !== input.targetNodeId) throw new Error(`Federation heartbeat acknowledgement came from unexpected node: ${message.from}`);
    const acceptance = await this.state.acceptMessage(message);
    if (!acceptance.accepted) throw new Error(`Federation heartbeat acknowledgement rejected: ${acceptance.reason}`);
    if (message.payload.nodeId !== input.targetNodeId || message.payload.acceptedNodeId !== this.nodeId) throw new Error('Federation heartbeat acknowledgement does not match request');
    return { nodeId: message.payload.nodeId, acceptedNodeId: message.payload.acceptedNodeId };
  }

  async dispatchTask(input: { endpoint: string; task: FederationTask }): Promise<FederationResult> {
    await this.state.init();
    if (!/^https?:\/\//.test(input.endpoint)) throw new Error('Federation endpoint must use http(s)');
    const targetNodeId = input.task.assignedNodeId;
    if (!targetNodeId) throw new Error('Federation task must have assignedNodeId before dispatch');
    const envelope = this.registry.sign(this.nodeId, targetNodeId, { kind: 'task' as const, task: structuredClone(input.task) }, this.secret, this.messageTtlMs);
    const message = await this.postEnvelope(`${input.endpoint.replace(/\/$/, '')}/v1/federation/task`, envelope, isResultMessage, 'result');
    if (message.from !== targetNodeId) throw new Error(`Federation response came from unexpected node: ${message.from}`);
    const acceptance = await this.state.acceptMessage(message);
    if (!acceptance.accepted) throw new Error(`Federation result rejected: ${acceptance.reason}`);
    const result = message.payload.result;
    if (result.taskId !== input.task.id || result.executionId !== input.task.executionId || result.nodeId !== targetNodeId) {
      throw new Error('Federation result does not match dispatched task');
    }

    if (input.task.leaseId) {
      if (result.leaseId !== input.task.leaseId || result.attempt !== input.task.attempt) throw new Error('Federation result fencing token does not match dispatched lease');
      return this.state.commitLeasedResult(result);
    }

    const durable = await this.state.importResult(result);
    await this.state.updateTask(input.task.id, {
      status: durable.success ? 'completed' : 'failed',
      ...(durable.success ? {} : { error: durable.error ?? 'Federation task failed' }),
    });
    return durable;
  }

  private async postEnvelope<TMessage extends FederationMessage<unknown>>(
    url: string,
    envelope: FederationMessage<unknown>,
    guard: (value: unknown) => value is TMessage,
    label: string,
  ): Promise<TMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Federation HTTP ${response.status}: ${text}`);
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!guard(parsed)) throw new Error(`invalid federation ${label} envelope`);
        return parsed;
      } catch (error) {
        throw new Error(`Invalid federation response: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error(`Federation HTTP request timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<{ text: string; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) return { text: '', tooLarge: true };
    chunks.push(buffer);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function acceptanceStatus(reason: string): number {
  return reason === 'invalid-signature' ? 401 : reason === 'wrong-recipient' ? 403 : 409;
}

function isTaskMessage(value: unknown): value is FederationMessage<{ kind: 'task'; task: FederationTask }> {
  if (!isEnvelope(value)) return false;
  const payload = value.payload;
  return isRecord(payload) && payload.kind === 'task' && isFederationTask(payload.task);
}

function isHeartbeatMessage(value: unknown): value is FederationMessage<{ kind: 'heartbeat'; node: FederationNodeHeartbeat }> {
  if (!isEnvelope(value)) return false;
  const payload = value.payload;
  return isRecord(payload) && payload.kind === 'heartbeat' && isFederationNodeHeartbeat(payload.node);
}

function isHeartbeatAckMessage(value: unknown): value is FederationMessage<{ kind: 'heartbeat-ack'; nodeId: string; acceptedNodeId: string }> {
  if (!isEnvelope(value)) return false;
  const payload = value.payload;
  return isRecord(payload) && payload.kind === 'heartbeat-ack' && typeof payload.nodeId === 'string' && typeof payload.acceptedNodeId === 'string';
}

function isResultMessage(value: unknown): value is FederationMessage<{ kind: 'result'; result: FederationResult }> {
  if (!isEnvelope(value)) return false;
  const payload = value.payload;
  return isRecord(payload) && payload.kind === 'result' && isFederationResult(payload.result);
}

function isEnvelope(value: unknown): value is FederationMessage<unknown> {
  if (!isRecord(value)) return false;
  return ['id', 'from', 'to', 'createdAt', 'expiresAt', 'nonce', 'signature'].every((key) => typeof value[key] === 'string') && 'payload' in value;
}

function isFederationNodeHeartbeat(value: unknown): value is FederationNodeHeartbeat {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.endpoint === 'string'
    && Array.isArray(value.capabilities) && value.capabilities.every((item) => typeof item === 'string')
    && (value.load === undefined || typeof value.load === 'number');
}

function isFederationTask(value: unknown): value is FederationTask {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.executionId === 'string' && typeof value.taskType === 'string' && typeof value.goal === 'string'
    && Array.isArray(value.requiredCapabilities) && value.requiredCapabilities.every((item) => typeof item === 'string')
    && isRecord(value.payload) && typeof value.status === 'string' && typeof value.attempt === 'number'
    && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
    && (value.leaseId === undefined || typeof value.leaseId === 'string');
}

function isFederationResult(value: unknown): value is FederationResult {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.taskId === 'string' && typeof value.executionId === 'string'
    && typeof value.nodeId === 'string' && typeof value.success === 'boolean' && typeof value.createdAt === 'string'
    && typeof value.attempt === 'number' && (value.leaseId === undefined || typeof value.leaseId === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
