import { describe, expect, it, vi } from 'vitest';

import {
  createIntegrationRateLimiter,
  getIntegrationRateLimitKey,
} from '../integration-rate-limit';

describe('integration rate limiting', () => {
  it('returns bounded remaining/reset metadata and limits one credential', async () => {
    const store = {
      consume: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(4),
    };
    const limiter = createIntegrationRateLimiter(store, 3);
    const request = { headers: { 'x-api-key': 'raw-secret-must-not-be-stored' } };

    const first = await limiter.consume(request);
    const second = await limiter.consume(request);
    const blocked = await limiter.consume(request);

    expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2 });
    expect(second).toMatchObject({ allowed: true, limit: 3, remaining: 0 });
    expect(blocked).toMatchObject({ allowed: false, limit: 3, remaining: 0 });
    expect(blocked.resetAt).toBeGreaterThan(Date.now());
    expect(store.consume).toHaveBeenCalledTimes(3);
  });

  it('hashes credentials before using them as a rate-limit key', () => {
    const key = getIntegrationRateLimitKey({
      headers: { authorization: 'Bearer raw-secret-must-not-be-stored' },
    });

    expect(key).toMatch(/^credential:[a-f0-9]{64}$/);
    expect(key).not.toContain('raw-secret');
  });
});
