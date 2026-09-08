import { describe, expect, it, vi } from 'vitest';

import { createIntegrationQuotaEnforcer } from '../integration-quota';

describe('integration quotas', () => {
  it('keeps quotas disabled by default when no daily limit is configured', async () => {
    const store = { consume: vi.fn() };
    const enforcer = createIntegrationQuotaEnforcer(store, 0);

    const result = await enforcer.consume({ headers: { 'x-api-key': 'key' } });

    expect(result).toMatchObject({ allowed: true, limit: 0, remaining: 0 });
    expect(store.consume).not.toHaveBeenCalled();
  });

  it('limits one credential and exposes a UTC-day reset window', async () => {
    const store = {
      consume: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3),
    };
    const enforcer = createIntegrationQuotaEnforcer(store, 2);
    const request = { headers: { 'x-api-key': 'raw-key-not-stored' } };

    const first = await enforcer.consume(request);
    const second = await enforcer.consume(request);
    const blocked = await enforcer.consume(request);

    expect(first).toMatchObject({ allowed: true, limit: 2, remaining: 1 });
    expect(second).toMatchObject({ allowed: true, limit: 2, remaining: 0 });
    expect(blocked).toMatchObject({ allowed: false, limit: 2, remaining: 0 });
    expect(blocked.resetAt).toBeGreaterThan(Date.now());
    expect(store.consume).toHaveBeenCalledWith(
      expect.stringMatching(/^credential:[a-f0-9]{64}$/),
      expect.any(Number),
    );
  });
});
