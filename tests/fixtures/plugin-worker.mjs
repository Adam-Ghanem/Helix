process.stdin.setEncoding('utf8');
let pending = '';

process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    void handle(line);
  }
});

async function handle(line) {
  const request = JSON.parse(line);
  if (request.method === 'plugin/handshake') {
    respond(request.id, {
      protocolVersion: '1',
      pluginId: request.params.pluginId,
      capabilities: { tools: true, hooks: true },
    });
    return;
  }

  if (request.method === 'tool/call') {
    if (request.params.name === 'crash') {
      process.exit(17);
      return;
    }
    respond(request.id, { name: request.params.name, input: request.params.input });
    return;
  }

  if (request.method === 'hook/call') {
    respond(request.id, {
      name: request.params.name,
      event: request.params.event,
      context: request.params.context,
    });
    return;
  }

  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: `unknown method: ${request.method}` } })}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
