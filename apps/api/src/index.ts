import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { HelixRuntime } from '../../../packages/runtime/src/index.js';

const port = Number(process.env.HELIX_PORT ?? 8787);
const dataDirectory = process.env.HELIX_DATA_DIR ?? join(process.cwd(), '.helix');
const runtime = new HelixRuntime({ dataDirectory });
await runtime.init();

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    response.end();
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/v1/health' && request.method === 'GET') return json(response, 200, { status: 'ok', service: 'helix-api', provider: runtime.provider.name, sequence: runtime.events.lastSequence });
    if (url.pathname === '/api/v1/agents' && request.method === 'GET') return json(response, 200, { agents: runtime.agents.list() });
    if (url.pathname === '/api/v1/approvals' && request.method === 'GET') return json(response, 200, { approvals: runtime.policy.listApprovals(url.searchParams.get('status') as 'pending' | 'approved' | 'denied' | 'expired' | null ?? undefined) });
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
    const executionMatch = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
    if (executionMatch && request.method === 'GET') return json(response, 200, await runtime.view(executionMatch[1]!));
    if (url.pathname === '/api/v1/events' && request.method === 'GET') return json(response, 200, { events: await runtime.events.read() });
    if (url.pathname === '/api/v1/verify' && request.method === 'GET') return json(response, 200, { ok: true, sequence: runtime.events.lastSequence, provider: runtime.provider.name, dataDirectory });
    return json(response, 404, { error: 'not_found' });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Helix API listening on http://localhost:${port}`));

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());

export { server, runtime };
