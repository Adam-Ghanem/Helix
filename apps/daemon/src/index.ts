#!/usr/bin/env node
import { join } from 'node:path';
import { HelixDaemon } from '../../../packages/daemon/src/index.js';
import { HttpModelProvider } from '../../../packages/runtime/src/index.js';

const dataDirectory = process.env.HELIX_DATA_DIR ?? join(process.cwd(), '.helix');
const concurrency = Number(process.env.HELIX_WORKERS ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('HELIX_WORKERS must be an integer from 1 to 64');

const modelProvider = process.env.HELIX_MODEL_API_URL && process.env.HELIX_MODEL_API_KEY && process.env.HELIX_MODEL
  ? new HttpModelProvider({ endpoint: process.env.HELIX_MODEL_API_URL, apiKey: process.env.HELIX_MODEL_API_KEY, model: process.env.HELIX_MODEL })
  : undefined;

const daemon = new HelixDaemon({ dataDirectory, concurrency, ...(modelProvider ? { provider: modelProvider } : {}) });

async function main(): Promise<void> {
  await daemon.start();
  console.log(`Helix daemon started (pid=${process.pid}, workers=${concurrency}, data=${dataDirectory})`);
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void daemon.shutdown().then(resolve, reject);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

main().catch(async (error: unknown) => {
  try {
    await daemon.shutdown();
  } catch {
    // Preserve the original daemon failure.
  }
  console.error(`helix-daemon: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
