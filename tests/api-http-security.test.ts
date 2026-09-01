import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { createHttpHelpers } from '../apps/api/src/http.js';

function requestFrom(remoteAddress: string): IncomingMessage {
  return { socket: { remoteAddress } } as unknown as IncomingMessage;
}

test('API rate limiter bounds tracked client addresses and reclaims expired buckets', () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const http = createHttpHelpers({ maxBodyBytes: 1024, rateLimitPerMinute: 10 });
    for (let index = 0; index < 10_000; index += 1) {
      assert.equal(http.withinRateLimit(requestFrom(`198.51.${Math.floor(index / 256)}.${index % 256}`)), true);
    }

    assert.equal(http.withinRateLimit(requestFrom('203.0.113.250')), false, 'new client must fail closed when tracking capacity is exhausted');

    now += 60_001;
    assert.equal(http.withinRateLimit(requestFrom('203.0.113.250')), true, 'expired client buckets must be reclaimed');
  } finally {
    Date.now = originalNow;
  }
});
