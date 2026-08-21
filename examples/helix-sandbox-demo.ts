import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, defaultSandboxPolicy } from '../packages/sandbox/src/index.js';

const workspace = await mkdtemp(join(tmpdir(), 'helix-sandbox-demo-'));
try {
  const manager = new SandboxManager();
  await manager.init();
  const policy = { ...defaultSandboxPolicy(workspace), allowedExecutables: [process.execPath], environmentAllowlist: [] };
  const created = await manager.create({ policy, backend: 'local', executionId: 'demo-execution', agentId: 'demo-agent' });
  await manager.start(created.sandboxId);
  const result = await manager.exec(created.sandboxId, { command: process.execPath, args: ['-e', "process.stdout.write('sandbox-ok')"], cwd: '.', env: {} });
  console.log(JSON.stringify({ snapshot: manager.status(created.sandboxId), result, audits: manager.audits(created.sandboxId) }, null, 2));
  await manager.destroy(created.sandboxId);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
