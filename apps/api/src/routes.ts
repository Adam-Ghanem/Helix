import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { HelixRuntime } from '../../../packages/runtime/src/index.js';
import { createHttpHelpers, type HttpSecurityOptions } from './http.js';

export interface HelixRequestHandlerOptions {
  runtime: HelixRuntime;
  security: HttpSecurityOptions;
  dashboardRoot: string;
  dataDirectory?: string;
}

export type HelixRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const DASHBOARD_ASSETS: Readonly<Record<string, { relativePath: string; contentType: string }>> = Object.freeze({
  '/': { relativePath: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/dashboard/app.js': { relativePath: 'src/app.js', contentType: 'text/javascript; charset=utf-8' },
  '/dashboard/api.js': { relativePath: 'src/api.js', contentType: 'text/javascript; charset=utf-8' },
  '/dashboard/state.js': { relativePath: 'src/state.js', contentType: 'text/javascript; charset=utf-8' },
  '/dashboard/render.js': { relativePath: 'src/render.js', contentType: 'text/javascript; charset=utf-8' },
  '/dashboard/styles.css': { relativePath: 'src/styles.css', contentType: 'text/css; charset=utf-8' },
});

export function createHelixRequestHandler(options: HelixRequestHandlerOptions): HelixRequestHandler {
  const { runtime, dashboardRoot } = options;
  const http = createHttpHelpers(options.security);

  return async (request, response): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          ...http.corsHeaders(),
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type,x-helix-approver',
        });
        response.end();
        return;
      }

      if (!http.authorized(request, url.pathname)) {
        http.json(response, 401, { error: 'unauthorized' });
        return;
      }
      if (!http.withinRateLimit(request)) {
        http.json(response, 429, { error: 'rate_limit_exceeded' });
        return;
      }

      if (request.method === 'GET' && DASHBOARD_ASSETS[url.pathname]) {
        await serveDashboardAsset(response, dashboardRoot, DASHBOARD_ASSETS[url.pathname]!, http.corsHeaders());
        return;
      }

      if (url.pathname === '/api/v1/health' && request.method === 'GET') {
        http.json(response, 200, { status: 'ok', service: 'helix-api', provider: runtime.provider.name, sequence: runtime.events.lastSequence, auth: Boolean(options.security.apiKey) });
        return;
      }
      if (url.pathname === '/api/v1/agents' && request.method === 'GET') {
        http.json(response, 200, { agents: runtime.agents.list() });
        return;
      }
      if (url.pathname === '/api/v1/memory/search' && request.method === 'GET') {
        const query = url.searchParams.get('q') ?? '';
        const namespace = url.searchParams.get('namespace') ?? 'default';
        const subject = url.searchParams.get('subject') ?? 'api-user';
        http.json(response, 200, { hits: await runtime.recall({ query, namespace, subject, limit: Number(url.searchParams.get('limit') ?? 20) }) });
        return;
      }
      if (url.pathname === '/api/v1/memory' && request.method === 'POST') {
        const input = await http.readJsonBody(request);
        if (typeof input.content !== 'string' || !input.content.trim()) {
          http.json(response, 400, { error: 'content is required' });
          return;
        }
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
        http.json(response, 201, record);
        return;
      }
      if (url.pathname === '/api/v1/telemetry' && request.method === 'GET') {
        http.json(response, 200, runtime.telemetrySnapshot());
        return;
      }
      if (url.pathname === '/api/v1/approvals' && request.method === 'GET') {
        http.json(response, 200, { approvals: runtime.policy.listApprovals(statusFilter(url.searchParams.get('status'))) });
        return;
      }
      if (url.pathname === '/api/v1/executions' && request.method === 'POST') {
        const input = await http.readJsonBody(request);
        if (typeof input.goal !== 'string' || !input.goal.trim()) {
          http.json(response, 400, { error: 'goal is required' });
          return;
        }
        const execution = typeof input.budget === 'object' && input.budget
          ? await runtime.execute({ goal: input.goal, budget: input.budget as never })
          : await runtime.execute({ goal: input.goal });
        http.json(response, 201, execution);
        return;
      }
      if (url.pathname === '/api/v1/executions' && request.method === 'GET') {
        const events = await runtime.events.read((event) => event.type === 'execution.started');
        http.json(response, 200, { executions: events.map((event) => (event.payload as { execution: unknown }).execution) });
        return;
      }

      const lifecycleMatch = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)\/(pause|resume|cancel|retry|checkpoint)$/);
      if (lifecycleMatch && request.method === 'POST') {
        const executionId = lifecycleMatch[1]!;
        const action = lifecycleMatch[2]!;
        if (action === 'pause') http.json(response, 200, await runtime.pause(executionId));
        else if (action === 'resume') http.json(response, 200, await runtime.resume(executionId));
        else if (action === 'cancel') http.json(response, 200, await runtime.cancel(executionId));
        else if (action === 'retry') http.json(response, 200, await runtime.retry(executionId));
        else http.json(response, 200, await runtime.checkpoint(executionId));
        return;
      }

      const approvalMatch = url.pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/(approve|deny)$/);
      if (approvalMatch && request.method === 'POST') {
        const approvalId = approvalMatch[1]!;
        const decidedBy = request.headers['x-helix-approver'] ?? 'api-user';
        const approval = approvalMatch[2] === 'approve' ? runtime.policy.approve(approvalId, String(decidedBy)) : runtime.policy.deny(approvalId, String(decidedBy));
        await runtime.events.append({ type: `approval.${approval.status}`, executionId: approval.executionId, agentId: approval.requestedBy, payload: approval });
        http.json(response, 200, approval);
        return;
      }

      const executionMatch = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
      if (executionMatch && request.method === 'GET') {
        http.json(response, 200, await runtime.view(executionMatch[1]!));
        return;
      }
      if (url.pathname === '/api/v1/events' && request.method === 'GET') {
        http.json(response, 200, { events: await runtime.events.read() });
        return;
      }
      if (url.pathname === '/api/v1/recover' && request.method === 'POST') {
        http.json(response, 200, { recovered: await runtime.recover(), sequence: runtime.events.lastSequence });
        return;
      }
      if (url.pathname === '/api/v1/verify' && request.method === 'GET') {
        http.json(response, 200, {
          ok: true,
          sequence: runtime.events.lastSequence,
          provider: runtime.provider.name,
          ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}),
        });
        return;
      }
      http.json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof SyntaxError || /unknown|not found|exceeds|invalid|already|not failed|JSON|body/i.test(message) ? 400 : 500;
      http.json(response, status, { error: message });
    }
  };
}

async function serveDashboardAsset(
  response: ServerResponse,
  dashboardRoot: string,
  asset: { relativePath: string; contentType: string },
  corsHeaders: Record<string, string>,
): Promise<void> {
  try {
    const contents = await readFile(join(dashboardRoot, asset.relativePath));
    response.writeHead(200, {
      'content-type': asset.contentType,
      'cache-control': 'no-store',
      ...corsHeaders,
    });
    response.end(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders });
      response.end('Not found');
      return;
    }
    throw error;
  }
}

function statusFilter(value: string | null): 'pending' | 'approved' | 'denied' | 'expired' | undefined {
  return value === 'pending' || value === 'approved' || value === 'denied' || value === 'expired' ? value : undefined;
}
