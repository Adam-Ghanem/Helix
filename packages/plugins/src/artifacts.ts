import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { ManagedPluginArtifactRecord } from './store.js';

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export interface PluginArtifactStoreOptions {
  directory: string;
  maxBytes?: number;
}

export class PluginArtifactStore {
  private readonly directory: string;
  private readonly blobDirectory: string;
  private readonly maxBytes: number;

  constructor(options: PluginArtifactStoreOptions) {
    if (!options.directory.trim()) throw new Error('Plugin artifact store directory is required');
    this.directory = resolve(options.directory);
    this.blobDirectory = join(this.directory, 'sha256');
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) throw new Error('Plugin artifact maxBytes must be a positive integer');
  }

  async install(sourcePath: string, expectedDigest: string): Promise<ManagedPluginArtifactRecord> {
    const digest = normalizeDigest(expectedDigest);
    const extension = extname(sourcePath).toLowerCase();
    if (extension !== '.js' && extension !== '.mjs') throw new Error('Plugin artifact must be a single .js or .mjs file');

    const bytes = await readRegularFile(sourcePath, this.maxBytes);
    assertDigest(bytes, digest);

    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 });
    const destination = join(this.blobDirectory, `${digest}.mjs`);

    try {
      const existing = await this.verify({ digest, path: destination, size: bytes.length }, digest);
      return existing;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const temporary = join(this.blobDirectory, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o500);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const temporaryBytes = await readRegularFile(temporary, this.maxBytes);
      assertDigest(temporaryBytes, digest);
      try {
        // Hard-link publication is atomic within the same directory and never
        // replaces an already-published content-addressed blob.
        await link(temporary, destination);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }

    return this.verify({ digest, path: destination, size: bytes.length }, digest);
  }

  async verify(record: ManagedPluginArtifactRecord, expectedDigest: string): Promise<ManagedPluginArtifactRecord> {
    const digest = normalizeDigest(expectedDigest);
    const recordDigest = normalizeDigest(record.digest);
    if (!sameDigest(recordDigest, digest)) throw new Error('Plugin artifact record digest does not match manifest digest');
    if (!Number.isInteger(record.size) || record.size < 0 || record.size > this.maxBytes) throw new Error('Plugin artifact record size is invalid');

    const candidate = resolve(record.path);
    const root = resolve(this.blobDirectory);
    if (!isInside(candidate, root)) throw new Error('Plugin artifact path is outside the managed artifact store');
    if (basename(candidate) !== `${digest}.mjs`) throw new Error('Plugin artifact path does not match its digest');

    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    const canonicalParent = await realpath(dirname(candidate));
    if (!isInside(canonicalParent, canonicalRoot)) throw new Error('Plugin artifact parent escapes the managed artifact store');

    const bytes = await readRegularFile(candidate, this.maxBytes);
    assertDigest(bytes, digest);
    if (bytes.length !== record.size) throw new Error('Plugin artifact size does not match durable metadata');
    return { digest, path: candidate, size: bytes.length };
  }
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`Plugin artifact must be a regular file: ${path}`);
  if (metadata.size > maxBytes) throw new Error(`Plugin artifact exceeds maximum size of ${maxBytes} bytes`);

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`Plugin artifact must be a regular file: ${path}`);
    if (opened.size > maxBytes) throw new Error(`Plugin artifact exceeds maximum size of ${maxBytes} bytes`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error(`Plugin artifact exceeds maximum size of ${maxBytes} bytes`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function normalizeDigest(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error('Plugin artifact digest must be a SHA-256 hex digest');
  return value.toLowerCase();
}

function assertDigest(bytes: Buffer, expected: string): void {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!sameDigest(actual, expected)) throw new Error('Plugin artifact digest mismatch');
}

function sameDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isInside(candidate: string, root: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === '' || (!remainder.startsWith('..') && !remainder.startsWith('/') && !remainder.startsWith('\\'));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EEXIST');
}
