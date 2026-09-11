import { describe, expect, it } from 'vitest';

import { normalizeProviderWarningsForDisplay } from '../utils/provider-warnings';

describe('provider warning display normalization', () => {
  it('collapses repeated search-engine circuit-breaker notices without hiding the latest status', () => {
    const warnings = normalizeProviderWarningsForDisplay([
      {
        providerId: 'notarycafe-indexed-search-brave',
        providerName: 'Brave Search',
        message: 'Brave Search was unavailable for part of the indexed NotaryCafe search.',
      },
      {
        providerId: 'linkedin-search-brave',
        providerName: 'Brave Search',
        message: 'Brave Search was paused after repeated failures. Discovery continued with available fallback providers.',
      },
      {
        providerId: 'public-business-listings',
        providerName: 'Public Business Listings',
        message: 'Public listing discovery timed out; other public results were preserved.',
      },
    ]);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({
      providerName: 'Brave Search',
      severity: 'info',
    });
    expect(warnings[0]?.message).toContain('2 handled Brave Search status updates');
    expect(warnings[0]?.message).toContain('paused after repeated failures');
    expect(warnings[1]).toMatchObject({
      providerName: 'Public Business Listings',
      severity: 'info',
    });
  });

  it('keeps an unexplained legacy failure actionable', () => {
    const [warning] = normalizeProviderWarningsForDisplay([
      {
        providerId: 'linkedin-public-search',
        providerName: 'Public LinkedIn Search',
        message: 'Public discovery failed unexpectedly.',
      },
    ]);

    expect(warning?.severity).toBe('warning');
  });
});
