import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_PROTOCOL_VERSION, McpClient, type McpSubscriptionEvent } from '../packages/mcp/src/index.js';

function sse(value: unknown): string {
  return `event: message\ndata: ${JSON.stringify(value)}\n\n`;
}

test('MCP Streamable HTTP listen resolves on ack, filters notifications, and closes gracefully', async () => {
  const seenRequests: Array<{ method: string; params: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id: number | string; method: string; params: Record<string, unknown> };
    seenRequests.push({ method: message.method, params: message.params, headers: request.headers });
    if (message.method !== 'subscriptions/listen') {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'text/event-stream');
    response.write(sse({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        notifications: { resourcesListChanged: true, resourceSubscriptions: ['memory://one'] },
        _meta: { 'io.modelcontextprotocol/subscriptionId': message.id },
      },
    }));
    response.write(sse({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: { _meta: { 'io.modelcontextprotocol/subscriptionId': message.id } },
    }));
    response.write(sse({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'memory://one', _meta: { 'io.modelcontextprotocol/subscriptionId': message.id } },
    }));
    setTimeout(() => {
      response.write(sse({ jsonrpc: '2.0', id: message.id, result: {} }));
      response.end();
    }, 10);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const events: McpSubscriptionEvent[] = [];
  const client = new McpClient({ id: 'listen-http', endpoint: `http://127.0.0.1:${address.port}/mcp`, transport: 'streamable-http', trust: 'reviewed', timeoutMs: 1_000 });
  try {
    const subscription = await client.listen(
      { resourcesListChanged: true, resourceSubscriptions: ['memory://one'] },
      (event) => { events.push(event); },
    );
    assert.deepEqual(subscription.honoredFilter, { resourcesListChanged: true, resourceSubscriptions: ['memory://one'] });
    assert.equal(await subscription.closed, 'graceful');
    assert.deepEqual(events, [{ type: 'resource-updated', uri: 'memory://one' }]);
    assert.equal(seenRequests[0]?.headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION);
    assert.equal(seenRequests[0]?.headers['mcp-method'], 'subscriptions/listen');
    assert.equal((seenRequests[0]?.params.notifications as { resourcesListChanged?: boolean }).resourcesListChanged, true);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('MCP Streamable HTTP subscription close aborts the listen stream and reports local closure', async () => {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id: number | string; method: string };
    response.statusCode = 200;
    response.setHeader('content-type', 'text/event-stream');
    response.write(sse({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { notifications: { promptsListChanged: true }, _meta: { 'io.modelcontextprotocol/subscriptionId': message.id } },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const client = new McpClient({ id: 'listen-close', endpoint: `http://127.0.0.1:${address.port}/mcp`, transport: 'streamable-http', trust: 'reviewed', timeoutMs: 1_000 });
  try {
    const subscription = await client.listen({ promptsListChanged: true });
    await subscription.close();
    await subscription.close();
    assert.equal(await subscription.closed, 'local');
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
