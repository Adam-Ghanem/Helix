import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_PROTOCOL_VERSION, McpClient, McpGateway } from '../packages/mcp/src/index.js';
import { ToolRegistry } from '../packages/tools/src/index.js';

test('MCP client paginates resources/templates/prompts and reads content with cache hints', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: Record<string, unknown> };
    calls.push({ method: message.method, params: message.params, headers: request.headers });
    response.setHeader('content-type', 'application/json');
    const cursor = typeof message.params.cursor === 'string' ? message.params.cursor : undefined;
    let result: unknown;
    if (message.method === 'server/discover') {
      result = { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { resources: { listChanged: true }, prompts: { listChanged: true } } };
    } else if (message.method === 'resources/list') {
      result = cursor === 'r2'
        ? { resources: [{ uri: 'file:///b.txt', name: 'B', mimeType: 'text/plain' }], ttlMs: 1000, cacheScope: 'private' }
        : { resources: [{ uri: 'file:///a.txt', name: 'A', description: 'Alpha', mimeType: 'text/plain' }], nextCursor: 'r2', ttlMs: 5000, cacheScope: 'public' };
    } else if (message.method === 'resources/templates/list') {
      result = { resourceTemplates: [{ uriTemplate: 'file:///{name}.txt', name: 'Files', description: 'Read a file', mimeType: 'text/plain' }], ttlMs: 2500, cacheScope: 'public' };
    } else if (message.method === 'resources/read') {
      result = { contents: [{ uri: message.params.uri, mimeType: 'text/plain', text: 'hello' }], ttlMs: 750, cacheScope: 'private' };
    } else if (message.method === 'prompts/list') {
      result = { prompts: [{ name: 'review', description: 'Review code', arguments: [{ name: 'language', description: 'Language', required: true }] }], ttlMs: 4000, cacheScope: 'public' };
    } else if (message.method === 'prompts/get') {
      result = { description: 'Review code', messages: [{ role: 'user', content: { type: 'text', text: `Review ${(message.params.arguments as { language?: string }).language}` } }] };
    } else {
      response.statusCode = 404;
      result = { error: 'unknown method' };
    }
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new McpClient({ id: 'content', endpoint: `http://127.0.0.1:${address.port}/mcp`, transport: 'streamable-http', trust: 'reviewed', timeoutMs: 1000 });
  try {
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri), ['file:///a.txt', 'file:///b.txt']);
    assert.deepEqual(resources.cache, { ttlMs: 1000, cacheScope: 'private' });

    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates[0]?.uriTemplate, 'file:///{name}.txt');
    assert.deepEqual(templates.cache, { ttlMs: 2500, cacheScope: 'public' });

    const read = await client.readResource('file:///a.txt');
    assert.equal((read.contents[0] as { text?: string }).text, 'hello');
    assert.deepEqual(read.cache, { ttlMs: 750, cacheScope: 'private' });

    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts[0]?.name, 'review');
    assert.equal(prompts.prompts[0]?.arguments?.[0]?.required, true);
    assert.deepEqual(prompts.cache, { ttlMs: 4000, cacheScope: 'public' });

    const prompt = await client.getPrompt('review', { language: 'TypeScript' });
    assert.equal((prompt.messages[0]?.content as { text?: string }).text, 'Review TypeScript');

    const readCall = calls.find((call) => call.method === 'resources/read');
    assert.equal(readCall?.headers['mcp-name'], 'file:///a.txt');
    const promptCall = calls.find((call) => call.method === 'prompts/get');
    assert.equal(promptCall?.headers['mcp-name'], 'review');
    assert.equal((promptCall?.params._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'], MCP_PROTOCOL_VERSION);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('MCP gateway exposes governed content APIs without registering resources as tools', async () => {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
    response.setHeader('content-type', 'application/json');
    let result: unknown;
    if (message.method === 'server/discover') result = { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { resources: {}, prompts: {} } };
    else if (message.method === 'resources/list') result = { resources: [{ uri: 'memory://one', name: 'One' }], ttlMs: 0, cacheScope: 'private' };
    else if (message.method === 'resources/read') result = { contents: [{ uri: 'memory://one', text: 'one' }], ttlMs: 0, cacheScope: 'private' };
    else if (message.method === 'prompts/list') result = { prompts: [{ name: 'one' }], ttlMs: 0, cacheScope: 'private' };
    else if (message.method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: 'one' } }] };
    else result = { resourceTemplates: [], ttlMs: 0, cacheScope: 'private' };
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const registry = new ToolRegistry();
  const gateway = new McpGateway(registry);
  gateway.registerServer({ id: 'content', endpoint: `http://127.0.0.1:${address.port}/mcp`, transport: 'streamable-http', trust: 'reviewed' });
  try {
    assert.equal((await gateway.listResources('content')).resources[0]?.uri, 'memory://one');
    assert.equal(((await gateway.readResource('content', 'memory://one')).contents[0] as { text?: string }).text, 'one');
    assert.equal((await gateway.listPrompts('content')).prompts[0]?.name, 'one');
    assert.equal((await gateway.getPrompt('content', 'one')).messages.length, 1);
    assert.equal(registry.list().some((tool) => tool.name.includes('memory://one')), false);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('MCP content APIs fail closed on malformed cache hints and definitions', async () => {
  const server = createServer(async (_request, response) => {
    let body = '';
    for await (const chunk of _request) body += chunk;
    const message = JSON.parse(body) as { id: number; method: string };
    response.setHeader('content-type', 'application/json');
    const result = message.method === 'resources/list'
      ? { resources: [{ uri: '', name: 'bad' }], ttlMs: -1, cacheScope: 'shared' }
      : { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { resources: {} } };
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new McpClient({ id: 'bad', endpoint: `http://127.0.0.1:${address.port}/mcp`, transport: 'streamable-http', trust: 'reviewed' });
  try {
    await assert.rejects(() => client.listResources(), /resource|cache/i);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
