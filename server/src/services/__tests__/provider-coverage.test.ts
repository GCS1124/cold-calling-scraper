import { describe, expect, it } from 'vitest';

import type { SearchProgress } from '../../types/search';
import { mergeProviderCoverage, recordProviderCoverage } from '../provider-coverage';

const progress = (): SearchProgress => ({
  discovered: 0,
  enriched: 0,
  totalCandidates: 0,
  requestedCount: 50,
  foundCount: 0,
  duplicatesRemoved: 0,
  currentSource: 'Testing',
  batchesCompleted: 0,
  estimatedRemaining: 50,
});

describe('provider coverage', () => {
  it('merges provider observations without losing the returned state', () => {
    const state = progress();

    recordProviderCoverage(state, [
      {
        providerId: 'public-linkedin',
        providerName: 'Public LinkedIn Search',
        status: 'configured',
        leadCount: 0,
        message: 'Configured.',
      },
    ]);
    recordProviderCoverage(state, [
      {
        providerId: 'public-linkedin',
        providerName: 'Public LinkedIn Search',
        status: 'returned',
        leadCount: 7,
        message: 'Returned candidates.',
      },
    ]);

    expect(state.providerCoverage).toEqual([
      {
        providerId: 'public-linkedin',
        providerName: 'Public LinkedIn Search',
        status: 'returned',
        leadCount: 7,
        message: 'Configured. Returned candidates.',
      },
    ]);
  });

  it('reports partial when a provider returns after an earlier failure', () => {
    const merged = mergeProviderCoverage(
      [
        {
          providerId: 'osm',
          providerName: 'OpenStreetMap',
          status: 'failed',
          leadCount: 0,
          message: 'First region timed out.',
        },
      ],
      [
        {
          providerId: 'osm',
          providerName: 'OpenStreetMap',
          status: 'returned',
          leadCount: 4,
          message: 'Second region returned candidates.',
        },
      ],
    );

    expect(merged[0]).toMatchObject({
      status: 'partial',
      leadCount: 4,
      message: 'First region timed out. Second region returned candidates.',
    });
  });

  it('keeps a partial state across later configured observations', () => {
    const merged = mergeProviderCoverage(
      [
        {
          providerId: 'google-places',
          providerName: 'Google Places',
          status: 'partial',
          leadCount: 2,
        },
      ],
      [
        {
          providerId: 'google-places',
          providerName: 'Google Places',
          status: 'configured',
          leadCount: 0,
        },
      ],
    );

    expect(merged[0]?.status).toBe('partial');
  });
});
