import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { HelixRuntime, HttpModelProvider } from '../../../packages/runtime/src/index.js';
import { HelixMcpServer } from '../../../packages/mcp/src/index.js';

const dataDirectory = process.env.HELIX_DATA_DIR ?? join(process.cwd(), '.helix');
const provider = process.env.HELIX_MODEL_API_URL && process.env.HELIX_MODEL_API_KEY && process.env.HELIX_MODEL
  ? new HttpModelProvider({ endpoint: process.env.HELIX_MODEL_API_URL, apiKey: process.env.HELIX_MODEL_API_KEY, model: process.env.HELIX_MODEL })
  : undefined;
const runtime = new HelixRuntime({ dataDirectory, ...(provider ? { provider } : {}) });
const mcp = new HelixMcpServer(runtime, { actorRoles: { 'mcp-user': 'viewer', 'mcp-operator': 'operator', 'mcp-admin': 'admin' } });

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); if (Buffer.concat(chunks).length > 2_000_000) throw new Error('MCP request body exceeds limit'); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function serveHttp(): Promise<void> {
  const port = Number(process.env.HELIX_MCP_PORT ?? 8790);
  const host = process.env.HELIX_MCP_HOST ?? '127.0.0.1';
  const server = createServer(async (request, response) => {
    if (request.url !== '/mcp') { response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' })); return; }
    try { await mcp.handleHttp(request, response, await readBody(request)); }
    catch { if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'MCP transport failure' })); }
  });
  server.listen(port, host, () => console.error(`Helix MCP Streamable HTTP listening on http://${host}:${port}/mcp`));
}

if (process.argv.includes('--http')) await serveHttp();
else await mcp.connectStdio();
