import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_PROTOCOL_VERSION, McpClient, McpGateway } from '../packages/mcp/src/index.js';
import { ToolRegistry } from '../packages/tools/src/index.js';

test('MCP Streamable HTTP discovers, imports, and executes remote tools', async () => {
  const calls: Array<{ method: string; headers: Record<string, string | string[] | undefined>; params: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: Record<string, unknown> };
    calls.push({ method: message.method, headers: request.headers, params: message.params });
    response.statusCode = 200;
    if (message.method === 'server/discover') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} } } }));
      return;
    }
    if (message.method === 'tools/list') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } }] } }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String((message.params.arguments as { text?: unknown })?.text ?? '') }] } })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const registry = new ToolRegistry();
  const gateway = new McpGateway(registry);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    gateway.registerServer({ id: 'remote', endpoint: `http://127.0.0.1:${address.port}/mcp`, transport: 'streamable-http', trust: 'reviewed', timeoutMs: 1_000 });
    const imported = await gateway.syncTools('remote');
    assert.equal(imported.length, 1);
    assert.equal(imported[0]?.name, 'mcp.remote.echo');
    const request = registry.request('mcp.remote.echo', 'ex', 'agent', { text: 'hello' });
    const result = await registry.executeAuthorized(request, async () => true) as { content: Array<{ type: string; text: string }> };
    assert.equal(result.content[0]?.text, 'hello');
    assert.equal(calls[0]?.headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION);
    assert.equal(calls[0]?.headers['mcp-method'], 'server/discover');
    assert.equal(calls[2]?.headers['mcp-name'], 'echo');
    const meta = calls[2]?.params._meta as Record<string, unknown>;
    assert.equal(meta['io.modelcontextprotocol/protocolVersion'], MCP_PROTOCOL_VERSION);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('MCP stdio transport uses newline-delimited modern JSON-RPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-mcp-stdio-'));
  const script = join(directory, 'server.mjs');
  await writeFile(script, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  let result;
  if (message.method === 'server/discover') result = { supportedVersions: [version], capabilities: { tools: {} } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'sum', description: 'Sum values', inputSchema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } } }] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: String(message.params.arguments.a + message.params.arguments.b) }] };
  else return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`, 'utf8');

  const client = new McpClient({ id: 'local', endpoint: process.execPath, args: [script], transport: 'stdio', trust: 'reviewed', timeoutMs: 1_000 });
  try {
    const discovery = await client.discover();
    assert.ok(discovery.supportedVersions.includes(MCP_PROTOCOL_VERSION));
    const tools = await client.listTools();
    assert.equal(tools[0]?.name, 'sum');
    const result = await client.callTool('sum', { a: 2, b: 3 });
    assert.equal((result.content?.[0] as { text?: string })?.text, '5');
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP refuses to spawn untrusted local stdio servers', () => {
  assert.throws(() => new McpClient({ id: 'unsafe', endpoint: process.execPath, transport: 'stdio', trust: 'untrusted' }), /untrusted MCP stdio/i);
});
