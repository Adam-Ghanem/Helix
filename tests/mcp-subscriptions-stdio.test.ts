import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, type McpSubscriptionEvent } from '../packages/mcp/src/index.js';

test('MCP stdio listen dispatches honored notifications and close sends notifications/cancelled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-mcp-listen-stdio-'));
  const script = join(directory, 'server.mjs');
  const cancellationFile = join(directory, 'cancel.json');
  await writeFile(script, `
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';
const cancellationFile = process.argv[2];
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let listenId;
rl.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === 'subscriptions/listen') {
    listenId = message.id;
    const meta = { 'io.modelcontextprotocol/subscriptionId': listenId };
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
      params: { notifications: { promptsListChanged: true }, _meta: meta }
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/prompts/list_changed', params: { _meta: meta }
    }) + '\\n');
    return;
  }
  if (message.method === 'notifications/cancelled') {
    await writeFile(cancellationFile, JSON.stringify(message.params), 'utf8');
    if (message.params?.requestId === listenId) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: listenId, result: {} }) + '\\n');
    }
  }
});
`, 'utf8');

  const events: McpSubscriptionEvent[] = [];
  const client = new McpClient({ id: 'stdio-listen', endpoint: process.execPath, args: [script, cancellationFile], transport: 'stdio', trust: 'reviewed', timeoutMs: 1_000 });
  try {
    const subscription = await client.listen({ promptsListChanged: true }, (event) => { events.push(event); });
    assert.deepEqual(subscription.honoredFilter, { promptsListChanged: true });
    await waitFor(() => events.length === 1);
    assert.deepEqual(events, [{ type: 'prompts-list-changed' }]);

    await subscription.close();
    assert.equal(await subscription.closed, 'local');
    await waitFor(async () => {
      try { return JSON.parse(await readFile(cancellationFile, 'utf8')).requestId === subscription.id; }
      catch { return false; }
    });
    const cancellation = JSON.parse(await readFile(cancellationFile, 'utf8')) as { requestId?: unknown; reason?: unknown };
    assert.equal(cancellation.requestId, subscription.id);
    assert.equal(typeof cancellation.reason, 'string');
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not met before timeout');
}
