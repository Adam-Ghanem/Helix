import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { HelixRuntime, HttpModelProvider } from '../../../packages/runtime/src/index.js';
import { createHelixRequestHandler } from './routes.js';

const port = boundedIntegerEnv('HELIX_PORT', 8787, 0, 65_535);
const host = process.env.HELIX_HOST ?? '127.0.0.1';
const dataDirectory = process.env.HELIX_DATA_DIR ?? join(process.cwd(), '.helix');
const modelProvider = process.env.HELIX_MODEL_API_URL && process.env.HELIX_MODEL_API_KEY && process.env.HELIX_MODEL
  ? new HttpModelProvider({ endpoint: process.env.HELIX_MODEL_API_URL, apiKey: process.env.HELIX_MODEL_API_KEY, model: process.env.HELIX_MODEL })
  : undefined;
const apiKey = process.env.HELIX_API_KEY;
const corsOrigin = process.env.HELIX_CORS_ORIGIN;
const maxBodyBytes = boundedIntegerEnv('HELIX_MAX_BODY_BYTES', 1_048_576, 1, 64 * 1024 * 1024);
const rateLimitPerMinute = boundedIntegerEnv('HELIX_RATE_LIMIT_PER_MINUTE', 120, 1, 1_000_000);
const runtime = new HelixRuntime({ dataDirectory, ...(modelProvider ? { provider: modelProvider } : {}) });
await runtime.init();

const handler = createHelixRequestHandler({
  runtime,
  dataDirectory,
  dashboardRoot: resolve(process.cwd(), 'apps/dashboard'),
  security: {
    maxBodyBytes,
    rateLimitPerMinute,
    ...(apiKey ? { apiKey } : {}),
    ...(corsOrigin !== undefined ? { corsOrigin } : {}),
  },
});

const server = createServer((request, response) => {
  void handler(request, response);
});

server.listen(port, host, () => console.log(`Helix API listening on http://${host}:${port}`));

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());

function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export { server, runtime };
