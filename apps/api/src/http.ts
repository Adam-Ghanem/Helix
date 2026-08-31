import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HttpSecurityOptions {
  apiKey?: string;
  corsOrigin?: string;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
}

export interface HttpHelpers {
  json(response: ServerResponse, status: number, body: unknown): void;
  readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>>;
  authorized(request: IncomingMessage, pathname: string): boolean;
  withinRateLimit(request: IncomingMessage): boolean;
  corsHeaders(): Record<string, string>;
}

export function createHttpHelpers(options: HttpSecurityOptions): HttpHelpers {
  const maxBodyBytes = positiveInteger(options.maxBodyBytes, 'maxBodyBytes');
  const rateLimitPerMinute = positiveInteger(options.rateLimitPerMinute, 'rateLimitPerMinute');
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const corsHeaders = (): Record<string, string> => options.corsOrigin
    ? { 'access-control-allow-origin': options.corsOrigin }
    : {};

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      'access-control-allow-headers': 'authorization,content-type,x-helix-approver',
    });
    response.end(JSON.stringify(body));
  };

  const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const rawContentLength = request.headers['content-length'];
    if (rawContentLength !== undefined) {
      const declared = Number(rawContentLength);
      if (!Number.isFinite(declared) || declared < 0 || declared > maxBodyBytes) throw new Error('request body exceeds configured limit');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBodyBytes) throw new Error('request body exceeds configured limit');
      chunks.push(buffer);
    }
    if (!chunks.length) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object');
    return parsed as Record<string, unknown>;
  };

  const authorized = (request: IncomingMessage, pathname: string): boolean => {
    if (!options.apiKey || isPublicPath(pathname)) return true;
    return request.headers.authorization === `Bearer ${options.apiKey}`;
  };

  const withinRateLimit = (request: IncomingMessage): boolean => {
    const address = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const current = buckets.get(address);
    if (!current || current.resetAt <= now) {
      buckets.set(address, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    current.count += 1;
    return current.count <= rateLimitPerMinute;
  };

  return { json, readJsonBody, authorized, withinRateLimit, corsHeaders };
}

function isPublicPath(pathname: string): boolean {
  return pathname === '/api/v1/health' || pathname === '/' || pathname.startsWith('/dashboard/');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
