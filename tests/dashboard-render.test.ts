import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

interface RenderModule {
  executionActionPath(executionId: string, action: string): string;
  approvalActionPath(approvalId: string, action: string): string;
}

async function loadRender(): Promise<RenderModule> {
  return await import(pathToFileURL(resolve('apps/dashboard/src/render.js')).href) as RenderModule;
}

test('dashboard shell uses same-origin first-party assets and contains no persistent credential or API-origin storage', async () => {
  const html = await readFile(resolve('apps/dashboard/index.html'), 'utf8');
  assert.match(html, /href="\/dashboard\/styles\.css"/);
  assert.match(html, /type="module"\s+src="\/dashboard\/app\.js"/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie/i);
  assert.doesNotMatch(html, /localhost:8787|HELIX_API|Bearer\s+[A-Za-z0-9]/i);
  assert.match(html, /data-view="overview"/);
  assert.match(html, /data-view="executions"/);
  assert.match(html, /data-view="approvals"/);
  assert.match(html, /data-view="telemetry"/);
  assert.match(html, /data-view="events"/);
});

test('dashboard render helpers encode identifiers and reject arbitrary mutation actions', async () => {
  const { executionActionPath, approvalActionPath } = await loadRender();
  assert.equal(executionActionPath('ex a/b?c', 'pause'), '/executions/ex%20a%2Fb%3Fc/pause');
  assert.equal(executionActionPath('ex-a', 'checkpoint'), '/executions/ex-a/checkpoint');
  assert.throws(() => executionActionPath('ex-a', 'delete'), /action/i);
  assert.equal(approvalActionPath('ap a/b', 'approve'), '/approvals/ap%20a%2Fb/approve');
  assert.throws(() => approvalActionPath('ap-a', 'escalate'), /action/i);
});

test('dashboard renderer avoids HTML injection sinks for runtime-provided strings', async () => {
  const source = await readFile(resolve('apps/dashboard/src/render.js'), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
  assert.match(source, /textContent/);
});
