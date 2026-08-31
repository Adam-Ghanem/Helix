import { createInterface } from 'node:readline';

const protocolVersion = '1';
const pluginId = process.env.HELIX_PLUGIN_ID;

if (!pluginId) throw new Error('HELIX_PLUGIN_ID is required');

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (!request || request.jsonrpc !== '2.0' || typeof request.id !== 'string' || typeof request.method !== 'string') {
      throw new Error('invalid request envelope');
    }
    const result = await dispatch(request.method, request.params ?? {});
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  } catch (error) {
    if (request?.id && typeof request.id === 'string') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      })}\n`);
    }
  }
});

async function dispatch(method, params) {
  if (method === 'plugin/handshake') {
    if (params.pluginId !== pluginId) throw new Error('plugin id mismatch');
    return {
      protocolVersion,
      pluginId,
      capabilities: { tools: true, hooks: true },
    };
  }

  if (method === 'tool/call') {
    if (params.name !== 'inspect') throw new Error(`unknown tool: ${String(params.name)}`);
    return { text: String(params.input?.text ?? ''), isolated: true };
  }

  if (method === 'hook/call') {
    if (params.name !== 'audit') throw new Error(`unknown hook: ${String(params.name)}`);
    return {
      hookId: `plugin:${pluginId}:hook:audit`,
      action: 'continue',
      annotations: { isolatedWorker: true, event: params.event },
    };
  }

  throw new Error(`unknown method: ${method}`);
}
