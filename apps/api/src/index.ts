import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { HelixRuntime, HttpModelProvider } from '../../../packages/runtime/src/index.js';
import { parseNamespace } from '../../../packages/memory/src/index.js';
import type { MemoryEntryInput, MemoryType, MemoryAccessContext, TaskOutcomeLearningInput } from '../../../packages/memory/src/index.js';
import type { GoalRisk, GoalConstraints, ReplanTrigger } from '../../../packages/intelligence/src/index.js';

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
const orchestrator = runtime.createOrchestrator({ subject: 'api-user' });
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
    if (url.pathname === '/api/v1/goals' && request.method === 'GET') return json(response, 200, { goals: [...orchestrator.goals.values()] });
    if (url.pathname === '/api/v1/goals' && request.method === 'POST') { const input = await body(request); if (typeof input.title !== 'string' || !input.title.trim()) return json(response, 400, { error: 'title is required' }); const constraints = isRecord(input.constraints) ? input.constraints as GoalConstraints : undefined; return json(response, 201, await orchestrator.createGoal({ title: input.title, ...(typeof input.description === 'string' ? { description: input.description } : {}), ...(constraints ? { constraints } : {}), ...(Array.isArray(input.requiredCapabilities) ? { requiredCapabilities: input.requiredCapabilities.filter((value): value is string => typeof value === 'string') } : {}), ...(typeof input.priority === 'number' ? { priority: input.priority } : {}), ...(typeof input.urgency === 'number' ? { urgency: input.urgency } : {}), ...(typeof input.risk === 'string' ? { risk: input.risk as GoalRisk } : {}), ...(typeof input.expectedOutcome === 'string' ? { expectedOutcome: input.expectedOutcome } : {}) })); }
    const goalActionMatch = url.pathname.match(/^\/api\/v1\/goals\/([^/]+)\/(analyze|plan)$/);
    if (goalActionMatch && request.method === 'POST') { const goalId = goalActionMatch[1]!; if (goalActionMatch[2] === 'analyze') return json(response, 200, await orchestrator.analyzeGoal(goalId)); return json(response, 201, await orchestrator.createPlan(goalId)); }
    if (url.pathname === '/api/v1/plans' && request.method === 'GET') return json(response, 200, { plans: [...orchestrator.plans.values()] });
    if (url.pathname === '/api/v1/plans' && request.method === 'POST') { const input = await body(request); if (typeof input.goalId !== 'string') return json(response, 400, { error: 'goalId is required' }); return json(response, 201, await orchestrator.createPlan(input.goalId)); }
    const planActionMatch = url.pathname.match(/^\/api\/v1\/plans\/([^/]+)\/(validate|execute)$/);
    if (planActionMatch && request.method === 'POST') { const planId = planActionMatch[1]!; if (planActionMatch[2] === 'validate') return json(response, 200, await orchestrator.validatePlan(planId)); const input = await body(request); return json(response, 200, await orchestrator.executePlan(planId, typeof input.approvedBy === 'string' ? { approvedBy: input.approvedBy } : undefined)); }
    if (url.pathname === '/api/v1/orchestrations' && request.method === 'GET') return json(response, 200, { orchestrations: [...orchestrator.orchestrations.values()] });
    if (url.pathname === '/api/v1/orchestrations' && request.method === 'POST') { const input = await body(request); if (typeof input.title !== 'string' || !input.title.trim()) return json(response, 400, { error: 'title is required' }); return json(response, 201, await orchestrator.run({ title: input.title, ...(typeof input.description === 'string' ? { description: input.description } : {}), ...(typeof input.expectedOutcome === 'string' ? { expectedOutcome: input.expectedOutcome } : {}), ...(typeof input.priority === 'number' ? { priority: input.priority } : {}), ...(typeof input.urgency === 'number' ? { urgency: input.urgency } : {}), ...(typeof input.risk === 'string' ? { risk: input.risk as GoalRisk } : {}) }, typeof input.approvedBy === 'string' ? { approvedBy: input.approvedBy } : undefined)); }
    const orchestrationActionMatch = url.pathname.match(/^\/api\/v1\/orchestrations\/([^/]+)(?:\/(status|cancel|replan|evaluate|explain))?$/);
    if (orchestrationActionMatch && request.method === 'GET' && !orchestrationActionMatch[2]) return json(response, 200, await orchestrator.status(orchestrationActionMatch[1]!));
    if (orchestrationActionMatch && (request.method === 'GET' || request.method === 'POST')) { const orchestrationId = orchestrationActionMatch[1]!; const action = orchestrationActionMatch[2]!; if (action === 'status') return json(response, 200, await orchestrator.status(orchestrationId)); if (action === 'cancel') return json(response, 200, await orchestrator.cancel(orchestrationId)); if (action === 'replan') return json(response, 200, await orchestrator.replan(orchestrationId, 'manual' as ReplanTrigger)); if (action === 'evaluate') return json(response, 200, await orchestrator.evaluate(orchestrationId)); return json(response, 200, orchestrator.explain(orchestrationId)); }
    if (url.pathname === '/api/v1/swarms' && request.method === 'GET') return json(response, 200, { swarms: orchestrator.swarmList() });
    if (url.pathname === '/api/v1/swarms' && request.method === 'POST') { const input = await body(request); if (typeof input.name !== 'string' || !input.name.trim() || typeof input.goalId !== 'string' || !input.goalId.trim()) return json(response, 400, { error: 'name and goalId are required' }); return json(response, 201, await orchestrator.createSwarm({ name: input.name, goalId: input.goalId, ...(typeof input.topology === 'string' ? { topology: input.topology as import('../../../packages/swarm/src/index.js').DynamicSwarmTopology } : {}), ...(typeof input.strategy === 'string' ? { strategy: input.strategy as 'adaptive' | 'capability' | 'quality' | 'latency' | 'hybrid' } : {}), ...(typeof input.minAgents === 'number' ? { minAgents: input.minAgents } : {}), ...(typeof input.maxAgents === 'number' ? { maxAgents: input.maxAgents } : {}), ...(typeof input.risk === 'string' ? { risk: input.risk as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' } : {}), ...(typeof input.approvedBy === 'string' ? { approvedBy: input.approvedBy } : {}) })); }
    const swarmMatch = url.pathname.match(/^\/api\/v1\/swarms\/([^/]+)(?:\/(status|members|scale|rebalance|delegate|handoff|topology|health|graph|critical-path|explain|cancel))?$/);
    if (swarmMatch && !swarmMatch[2] && request.method === 'GET') return json(response, 200, await Promise.resolve(orchestrator.swarmStatus(swarmMatch[1]!)));
    if (swarmMatch && swarmMatch[2]) { const swarmId = swarmMatch[1]!; const action = swarmMatch[2]!; if ((action === 'status' || action === 'members') && request.method === 'GET') return json(response, 200, action === 'status' ? orchestrator.swarmStatus(swarmId) : { swarmId, members: orchestrator.swarmStatus(swarmId).members }); if (action === 'health' && request.method === 'GET') return json(response, 200, await orchestrator.swarmHealth(swarmId)); if (action === 'graph' && request.method === 'GET') return json(response, 200, orchestrator.swarmCollaboration(swarmId)); if (action === 'critical-path' && request.method === 'GET') return json(response, 200, { swarmId, path: orchestrator.swarmCriticalPath(swarmId) }); if (action === 'explain' && request.method === 'GET') return json(response, 200, orchestrator.explainSwarm(swarmId)); if (action === 'scale' && request.method === 'POST') { const input = await body(request); if (typeof input.target !== 'number') return json(response, 400, { error: 'target is required' }); return json(response, 200, await orchestrator.scaleSwarm(swarmId, input.target)); } if (action === 'rebalance' && request.method === 'POST') { const input = await body(request); return json(response, 200, await orchestrator.rebalanceSwarm(swarmId, typeof input.reason === 'string' ? input.reason : undefined)); } if (action === 'delegate' && request.method === 'POST') { const input = await body(request); if (typeof input.taskId !== 'string' || !Array.isArray(input.capabilities)) return json(response, 400, { error: 'taskId and capabilities are required' }); return json(response, 201, await orchestrator.delegateToSwarm(swarmId, { id: input.taskId, title: typeof input.title === 'string' ? input.title : input.taskId, requiredCapabilities: input.capabilities.filter((value): value is string => typeof value === 'string'), dependencies: Array.isArray(input.dependencies) ? input.dependencies.filter((value): value is string => typeof value === 'string') : [], ...(typeof input.role === 'string' ? { role: input.role as import('../../../packages/swarm/src/index.js').SwarmRole } : {}), parallelizable: input.parallelizable === true }, (typeof input.target === 'string' ? input.target : 'swarm') as import('../../../packages/core/src/index.js').AgentId | import('../../../packages/swarm/src/index.js').SwarmRole | 'swarm')); } if (action === 'handoff' && request.method === 'POST') { const input = await body(request); if (typeof input.taskId !== 'string' || typeof input.fromAgentId !== 'string' || typeof input.toAgentId !== 'string' || typeof input.reason !== 'string') return json(response, 400, { error: 'taskId, fromAgentId, toAgentId, and reason are required' }); return json(response, 200, await orchestrator.handoffInSwarm(swarmId, input.taskId, input.fromAgentId, input.toAgentId, input.reason)); } if (action === 'topology' && request.method === 'POST') { const input = await body(request); if (typeof input.topology !== 'string') return json(response, 400, { error: 'topology is required' }); return json(response, 200, await orchestrator.switchSwarmTopology(swarmId, input.topology as import('../../../packages/swarm/src/index.js').DynamicSwarmTopology, typeof input.reason === 'string' ? input.reason : undefined)); } if (action === 'cancel' && request.method === 'POST') return json(response, 200, await runtime.swarms.cancel(swarmId)); }
    if (url.pathname === '/api/v1/memory/search' && request.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const namespaceText = url.searchParams.get('namespace');
      const subject = url.searchParams.get('subject') ?? 'api-user';
      const context: MemoryAccessContext = { subject, ...(subject.startsWith('agent_') ? { agentId: subject } : {}) };
      const hits = await runtime.searchMemory({ query, ...(namespaceText ? { namespace: parseNamespace(namespaceText) } : {}), limit: Number(url.searchParams.get('limit') ?? 20), context });
      const legacyHits = await runtime.recall({ query, namespace: namespaceText ?? 'default', subject, limit: Number(url.searchParams.get('limit') ?? 20) });
      return json(response, 200, { hits, legacyHits });
    }
    if (url.pathname === '/api/v1/memory' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.content !== 'string' || !input.content.trim()) return json(response, 400, { error: 'content is required' });
      if (typeof input.type === 'string' && isMemoryType(input.type) && isRecord(input.provenance) && isRecord(input.accessPolicy)) {
        const namespace = parseNamespace(typeof input.namespace === 'string' ? input.namespace : 'global');
        const owner = typeof input.owner === 'string' ? input.owner : 'api-user';
        const entryInput: MemoryEntryInput = { namespace, type: input.type, content: input.content, metadata: primitiveMetadata(input.metadata), source: typeof input.source === 'string' ? input.source : 'api', ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}), ...(typeof input.swarmId === 'string' ? { swarmId: input.swarmId } : {}), ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}), ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}), confidence: typeof input.confidence === 'number' ? input.confidence : 0.5, tags: Array.isArray(input.tags) ? input.tags.filter((value): value is string => typeof value === 'string') : [], provenance: parseProvenance(input.provenance), accessPolicy: { visibility: input.accessPolicy.visibility === 'private' || input.accessPolicy.visibility === 'shared' || input.accessPolicy.visibility === 'public' ? input.accessPolicy.visibility : 'private', allowedSubjects: Array.isArray(input.accessPolicy.allowedSubjects) ? input.accessPolicy.allowedSubjects.filter((value): value is string => typeof value === 'string') : [owner], allowedSwarmIds: Array.isArray(input.accessPolicy.allowedSwarmIds) ? input.accessPolicy.allowedSwarmIds.filter((value): value is string => typeof value === 'string') : [], owner }, };
        return json(response, 201, await runtime.rememberEntry(entryInput, { subject: owner }));
      }
      const record = await runtime.remember({ namespace: typeof input.namespace === 'string' ? input.namespace : 'default', owner: typeof input.owner === 'string' ? input.owner : 'api-user', content: input.content, importance: typeof input.importance === 'number' ? Math.max(0, Math.min(1, input.importance)) : 0.5, confidence: typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : 0.5, source: isRecord(input.source) ? input.source : {}, ...(typeof input.expiresAt === 'string' ? { expiresAt: input.expiresAt } : {}), allowedSubjects: Array.isArray(input.allowedSubjects) ? input.allowedSubjects.filter((value): value is string => typeof value === 'string') : ['api-user'] });
      return json(response, 201, record);
    }
    if (url.pathname === '/api/v1/memory/compact' && request.method === 'POST') {
      const input = await body(request);
      return json(response, 200, { result: await runtime.compactMemory({ mergePatterns: input.mergePatterns !== false, removeExpiredLegacy: input.removeExpiredLegacy === true, vacuum: input.vacuum === true }), cacheEntries: runtime.memoryCacheSize() });
    }
    if (url.pathname === '/api/v1/learning/flush' && request.method === 'POST') {
      await runtime.flushLearning();
      return json(response, 200, { pendingWrites: runtime.learning.pendingWrites });
    }
    const memoryMatch = url.pathname.match(/^\/api\/v1\/memory\/([^/]+)$/);
    if (memoryMatch && request.method === 'GET') return json(response, 200, await runtime.getMemory(memoryMatch[1]!, { subject: request.headers['x-helix-subject']?.toString() ?? 'api-user' }));
    if (memoryMatch && request.method === 'DELETE') { await runtime.deleteMemory(memoryMatch[1]!, { subject: request.headers['x-helix-subject']?.toString() ?? 'api-user' }); return json(response, 204, { deleted: true }); }
    if (url.pathname === '/api/v1/learning/hints' && request.method === 'GET') return json(response, 200, await runtime.learningHints(url.searchParams.get('task') ?? '', (url.searchParams.get('capabilities') ?? '').split(',').map((value) => value.trim()).filter(Boolean), { subject: request.headers['x-helix-subject']?.toString() ?? 'api-user' }));
    const experienceMatch = url.pathname.match(/^\/api\/v1\/learning\/agent\/([^/]+)$/);
    if (experienceMatch && request.method === 'GET') return json(response, 200, await runtime.agentExperience(experienceMatch[1]!));
    if (url.pathname === '/api/v1/learning/outcome' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.executionId !== 'string' || typeof input.taskId !== 'string' || typeof input.taskType !== 'string' || typeof input.agentId !== 'string' || typeof input.success !== 'boolean') return json(response, 400, { error: 'executionId, taskId, taskType, agentId, and success are required' });
      const outcome: TaskOutcomeLearningInput = { executionId: input.executionId, taskId: input.taskId, taskType: input.taskType, agentId: input.agentId, capabilities: Array.isArray(input.capabilities) ? input.capabilities.filter((value): value is string => typeof value === 'string') : [], success: input.success, quality: typeof input.quality === 'number' ? input.quality : input.success ? 0.75 : 0, executionTimeMs: typeof input.executionTimeMs === 'number' ? input.executionTimeMs : 0, attempts: typeof input.attempts === 'number' ? input.attempts : 1, ...(input.output !== undefined ? { output: input.output } : {}), ...(typeof input.error === 'string' ? { error: input.error } : {}) };
      return json(response, 201, { memories: await runtime.recordLearningOutcome(outcome) });
    }
    if (url.pathname === '/api/v1/telemetry' && request.method === 'GET') return json(response, 200, runtime.telemetrySnapshot());
    if (url.pathname === '/api/v1/approvals' && request.method === 'GET') return json(response, 200, { approvals: runtime.policy.listApprovals(statusFilter(url.searchParams.get('status'))) });
    if (url.pathname === '/api/v1/executions' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.goal !== 'string' || !input.goal.trim()) return json(response, 400, { error: 'goal is required' });
      const executionRequest = { goal: input.goal, ...(typeof input.budget === 'object' && input.budget ? { budget: input.budget as never } : {}), ...(typeof input.sandbox === 'object' && input.sandbox ? { sandbox: input.sandbox as never } : {}) };
      const execution = await runtime.execute(executionRequest);
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
    if (url.pathname === '/api/v1/sandboxes' && request.method === 'GET') return json(response, 200, { sandboxes: runtime.sandbox.list() });
    const sandboxMatch = url.pathname.match(/^\/api\/v1\/sandboxes\/([^/]+)$/);
    if (sandboxMatch && request.method === 'GET') { const sandboxId = sandboxMatch[1]!; return json(response, 200, { sandbox: runtime.sandbox.status(sandboxId), audits: runtime.sandbox.audits(sandboxId) }); }
    const sandboxDestroyMatch = url.pathname.match(/^\/api\/v1\/sandboxes\/([^/]+)\/destroy$/);
    if (sandboxDestroyMatch && request.method === 'POST') return json(response, 200, await runtime.sandbox.destroy(sandboxDestroyMatch[1]!));
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

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function primitiveMetadata(value: unknown): Record<string, string | number | boolean | null> { if (!isRecord(value)) return {}; const output: Record<string, string | number | boolean | null> = {}; for (const [key, item] of Object.entries(value)) if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) output[key] = item; return output; }
function isMemoryType(value: string): value is MemoryType { return ['fact', 'task', 'solution', 'pattern', 'failure', 'decision', 'observation', 'agent-experience', 'workflow', 'routing-hint'].includes(value); }
function parseProvenance(value: unknown): MemoryEntryInput['provenance'] { if (!isRecord(value) || typeof value.sourceType !== 'string' || typeof value.sourceId !== 'string' || typeof value.timestamp !== 'string' || typeof value.confidence !== 'number') throw new Error('provenance requires sourceType, sourceId, timestamp, and confidence'); return { sourceType: ['task-outcome', 'agent-observation', 'workflow', 'user', 'import', 'system'].includes(value.sourceType) ? value.sourceType as MemoryEntryInput['provenance']['sourceType'] : 'import', sourceId: value.sourceId, timestamp: value.timestamp, confidence: value.confidence, ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}), ...(typeof value.swarmId === 'string' ? { swarmId: value.swarmId } : {}), ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}), ...(typeof value.executionId === 'string' ? { executionId: value.executionId } : {}) }; }

export { server, runtime };
