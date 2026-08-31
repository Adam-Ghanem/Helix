import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PluginArtifactStore, type ManagedPluginArtifactRecord } from '../packages/plugins/src/index.js';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isInside(candidate: string, root: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === '' || (!remainder.startsWith('..') && !remainder.startsWith('/'));
}

test('plugin artifact store installs exact bytes into an immutable content-addressed path and reuses verified blobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helix-plugin-artifact-'));
  try {
    const source = join(root, 'worker.mjs');
    const bytes = 'process.stdout.write("ready\\n");\n';
    const digest = sha256(bytes);
    await writeFile(source, bytes, 'utf8');

    const directory = join(root, 'managed');
    const store = new PluginArtifactStore({ directory });
    const first = await store.install(source, digest);

    assert.equal(first.digest, digest);
    assert.equal(first.size, Buffer.byteLength(bytes));
    assert.ok(isInside(first.path, join(directory, 'sha256')));
    assert.equal(await readFile(first.path, 'utf8'), bytes);

    const secondSource = join(root, 'same-worker.js');
    await writeFile(secondSource, bytes, 'utf8');
    const second = await store.install(secondSource, digest.toUpperCase());
    assert.deepEqual(second, first);

    const verified = await store.verify(first, digest);
    assert.deepEqual(verified, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plugin artifact store rejects digest mismatch, symlinks, and non-regular sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helix-plugin-artifact-reject-'));
  try {
    const source = join(root, 'worker.mjs');
    await writeFile(source, 'export {};\n', 'utf8');
    const store = new PluginArtifactStore({ directory: join(root, 'managed') });

    await assert.rejects(() => store.install(source, sha256('different')), /digest|sha-?256/i);

    const linked = join(root, 'linked.mjs');
    await symlink(source, linked);
    await assert.rejects(() => store.install(linked, sha256('export {};\n')), /regular|symlink|artifact/i);

    const directorySource = join(root, 'directory.mjs');
    await mkdir(directorySource);
    await assert.rejects(() => store.install(directorySource, sha256('anything')), /regular|artifact/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plugin artifact verification fails closed after managed bytes are tampered or the record escapes the store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helix-plugin-artifact-tamper-'));
  try {
    const source = join(root, 'worker.mjs');
    const bytes = 'console.log("safe");\n';
    const digest = sha256(bytes);
    await writeFile(source, bytes, 'utf8');

    const directory = join(root, 'managed');
    const store = new PluginArtifactStore({ directory });
    const record = await store.install(source, digest);
    await chmod(record.path, 0o600);
    await writeFile(record.path, 'console.log("tampered");\n', 'utf8');
    await assert.rejects(() => store.verify(record, digest), /digest|tamper|artifact/i);

    const outside = join(root, 'outside.mjs');
    await writeFile(outside, bytes, 'utf8');
    const escaped: ManagedPluginArtifactRecord = { digest, path: outside, size: Buffer.byteLength(bytes) };
    await assert.rejects(() => store.verify(escaped, digest), /outside|path|artifact|store/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
