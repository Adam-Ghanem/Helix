import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { HelixRuntime, HttpModelProvider } from '../../../packages/runtime/src/index.js';

const port = Number(process.env.HELIX_PORT ?? 8787);
const host = process.env.HELIX_HOST ?? '127.0.0.1';
const dataDirectory = process.env.HELIX_DATA_DIR ?? join(process.cwd(), '.helix');
const modelProvider = process.env.HELIX_MODEL_API_URL && process.env.HELIX_MODEL_API_KEY && process.env.HELIX_MODEL
  ? new HttpModelProvider({ endpoint: process.env.HELIX_MODEL_API_URL, apiKey: process.env.HELIX_MODEL_API_KEY, model: process.env.HELIX_MODEL })
  : undefined;
const apiKey = process.env.HELIX_API_KEY;
const maxBodyBytes = Number(process.env.HELIX_MAX_BODY_BYTES ?? 1_048_576);
const rateLimitPerMinute = Number(process.env.HELIX_RATE_LIMIT_PER_MINUTE ?? 120);
const runtime = new HelixRuntime({ dataDirectory, ...(modelProvider ? { provider: modelProvider } : {}) });
const buckets = new Map<string, { count: number; resetAt: number }>();
await runtime.init();

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': process.env.HELIX_CORS_ORIGIN ?? '*',
    'access-control-allow-headers': 'authorization,content-type',
  });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > maxBodyBytes) throw new Error('request body exceeds configured limit');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error('request body exceeds configured limit');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function authorized(request: IncomingMessage, pathname: string): boolean {
  if (!apiKey || pathname === '/api/v1/health') return true;
  const header = request.headers.authorization;
  return header === `Bearer ${apiKey}`;
}

function withinRateLimit(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const current = buckets.get(address);
  if (!current || current.resetAt <= now) {
    buckets.set(address, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= rateLimitPerMinute;
}

function statusFilter(value: string | null): 'pending' | 'approved' | 'denied' | 'expired' | undefined {
  return value === 'pending' || value === 'approved' || value === 'denied' || value === 'expired' ? value : undefined;
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': process.env.HELIX_CORS_ORIGIN ?? '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type' });
    response.end();
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (!authorized(request, url.pathname)) return json(response, 401, { error: 'unauthorized' });
    if (!withinRateLimit(request)) return json(response, 429, { error: 'rate_limit_exceeded' });
    if (url.pathname === '/api/v1/health' && request.method === 'GET') return json(response, 200, { status: 'ok', service: 'helix-api', provider: runtime.provider.name, sequence: runtime.events.lastSequence, auth: Boolean(apiKey) });
    if (url.pathname === '/api/v1/agents' && request.method === 'GET') return json(response, 200, { agents: runtime.agents.list() });
    if (url.pathname === '/api/v1/memory/search' && request.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const namespace = url.searchParams.get('namespace') ?? 'default';
      const subject = url.searchParams.get('subject') ?? 'api-user';
      return json(response, 200, { hits: await runtime.recall({ query, namespace, subject, limit: Number(url.searchParams.get('limit') ?? 20) }) });
    }
    if (url.pathname === '/api/v1/memory' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.content !== 'string' || !input.content.trim()) return json(response, 400, { error: 'content is required' });
      const record = await runtime.remember({
        namespace: typeof input.namespace === 'string' ? input.namespace : 'default',
        owner: typeof input.owner === 'string' ? input.owner : 'api-user',
        content: input.content,
        importance: typeof input.importance === 'number' ? Math.max(0, Math.min(1, input.importance)) : 0.5,
        confidence: typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : 0.5,
        source: typeof input.source === 'object' && input.source ? input.source as never : {},
        ...(typeof input.expiresAt === 'string' ? { expiresAt: input.expiresAt } : {}),
        allowedSubjects: Array.isArray(input.allowedSubjects) ? input.allowedSubjects.filter((value): value is string => typeof value === 'string') : ['api-user'],
      });
      return json(response, 201, record);
    }
    if (url.pathname === '/api/v1/telemetry' && request.method === 'GET') return json(response, 200, runtime.telemetrySnapshot());
    if (url.pathname === '/api/v1/approvals' && request.method === 'GET') return json(response, 200, { approvals: runtime.policy.listApprovals(statusFilter(url.searchParams.get('status'))) });
    if (url.pathname === '/api/v1/executions' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.goal !== 'string' || !input.goal.trim()) return json(response, 400, { error: 'goal is required' });
      const execution = typeof input.budget === 'object' && input.budget
        ? await runtime.execute({ goal: input.goal, budget: input.budget as never })
        : await runtime.execute({ goal: input.goal });
      return json(response, 201, execution);
    }
    if (url.pathname === '/api/v1/executions' && request.method === 'GET') {
      const events = await runtime.events.read((event) => event.type === 'execution.started');
      return json(response, 200, { executions: events.map((event) => (event.payload as { execution: unknown }).execution) });
    }
    const lifecycleMatch = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)\/(pause|resume|cancel|retry|checkpoint)$/);
    if (lifecycleMatch && request.method === 'POST') {
      const executionId = lifecycleMatch[1]!;
      const action = lifecycleMatch[2]!;
      if (action === 'pause') return json(response, 200, await runtime.pause(executionId));
      if (action === 'resume') return json(response, 200, await runtime.resume(executionId));
      if (action === 'cancel') return json(response, 200, await runtime.cancel(executionId));
      if (action === 'retry') return json(response, 200, await runtime.retry(executionId));
      return json(response, 200, await runtime.checkpoint(executionId));
    }
    const approvalMatch = url.pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/(approve|deny)$/);
    if (approvalMatch && request.method === 'POST') {
      const approvalId = approvalMatch[1]!;
      const decidedBy = request.headers['x-helix-approver'] ?? 'api-user';
      const approval = approvalMatch[2] === 'approve' ? runtime.policy.approve(approvalId, String(decidedBy)) : runtime.policy.deny(approvalId, String(decidedBy));
      await runtime.events.append({ type: `approval.${approval.status}`, executionId: approval.executionId, agentId: approval.requestedBy, payload: approval });
      return json(response, 200, approval);
    }
    const executionMatch = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
    if (executionMatch && request.method === 'GET') return json(response, 200, await runtime.view(executionMatch[1]!));
    if (url.pathname === '/api/v1/events' && request.method === 'GET') return json(response, 200, { events: await runtime.events.read() });
    if (url.pathname === '/api/v1/recover' && request.method === 'POST') return json(response, 200, { recovered: await runtime.recover(), sequence: runtime.events.lastSequence });
    if (url.pathname === '/api/v1/verify' && request.method === 'GET') return json(response, 200, { ok: true, sequence: runtime.events.lastSequence, provider: runtime.provider.name, dataDirectory });
    return json(response, 404, { error: 'not_found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof SyntaxError || /unknown|not found|exceeds|invalid|already|not failed|JSON|body/i.test(message) ? 400 : 500;
    return json(response, status, { error: message });
  }
});

server.listen(port, host, () => console.log(`Helix API listening on http://${host}:${port}`));

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());

export { server, runtime };
