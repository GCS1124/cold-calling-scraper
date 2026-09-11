import { describe, expect, it, vi } from 'vitest';

import { runGeminiQueryAssistance } from '../gemini-query-assistance';

describe('runGeminiQueryAssistance', () => {
  it('keeps deterministic lenses without issuing a second Gemini request', async () => {
    const legacyExpansion = vi.fn().mockRejectedValue(new Error('must not run'));

    const result = await runGeminiQueryAssistance({
      request: {
        companyType: 'HVAC contractor',
        city: 'Austin, TX',
        count: 50,
        sourceMode: 'ai',
      },
      locationLabel: 'Austin, TX',
      deadlineMs: Date.now() + 10_000,
      seedHints: [
        'HVAC contractor owner Austin, TX',
        ' HVAC contractor owner Austin, TX ',
        'Austin HVAC founder public business phone',
      ],
      expandQuery: legacyExpansion,
    });

    expect(legacyExpansion).not.toHaveBeenCalled();
    expect(result.queryHints).toEqual([
      'HVAC contractor owner Austin, TX',
      'Austin HVAC founder public business phone',
    ]);
    expect(result.coverage).toMatchObject({
      providerId: 'gemini-query-assistance',
      providerName: 'Deterministic search planning',
      status: 'returned',
      phase: 'completed',
      outcome: 'returned',
      attemptedCount: 0,
      observedCount: 2,
      acceptedCount: 0,
    });
    expect(result.coverage.message).toContain('without a second Gemini request');
  });
});
