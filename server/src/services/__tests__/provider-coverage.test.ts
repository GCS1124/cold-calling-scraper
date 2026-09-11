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

  it('preserves structured provider outcomes and independently sums durable tick counts', () => {
    const merged = mergeProviderCoverage(
      [{
        providerId: 'public-website-enrichment',
        providerName: 'Public Website Enrichment',
        status: 'partial',
        phase: 'degraded',
        outcome: 'timed_out',
        leadCount: 1,
        attemptedCount: 2,
        observedCount: 2,
        acceptedCount: 1,
        reviewCount: 1,
        timedOutCount: 1,
        updatedAt: '2026-09-11T00:00:00.000Z',
      }],
      [{
        providerId: 'public-website-enrichment',
        providerName: 'Public Website Enrichment',
        status: 'returned',
        phase: 'completed',
        outcome: 'returned',
        leadCount: 1,
        attemptedCount: 1,
        observedCount: 1,
        acceptedCount: 1,
        completedCount: 1,
        enrichedCount: 1,
        updatedAt: '2026-09-11T00:00:01.000Z',
      }],
    );

    expect(merged[0]).toMatchObject({
      status: 'partial',
      phase: 'degraded',
      outcome: 'timed_out',
      leadCount: 2,
      attemptedCount: 3,
      observedCount: 3,
      acceptedCount: 2,
      reviewCount: 1,
      timedOutCount: 1,
      enrichedCount: 1,
      updatedAt: '2026-09-11T00:00:01.000Z',
    });
  });

  it('keeps deferred work as the latest remaining-work snapshot', () => {
    const merged = mergeProviderCoverage(
      [{
        providerId: 'public-business-listings',
        providerName: 'Public Business Listings',
        status: 'configured',
        phase: 'queued',
        outcome: 'deferred',
        leadCount: 0,
        attemptedCount: 4,
        deferredCount: 8,
      }],
      [{
        providerId: 'public-business-listings',
        providerName: 'Public Business Listings',
        status: 'configured',
        phase: 'queued',
        outcome: 'deferred',
        leadCount: 0,
        attemptedCount: 4,
        deferredCount: 4,
      }],
    );

    expect(merged[0]).toMatchObject({
      attemptedCount: 8,
      deferredCount: 4,
      outcome: 'deferred',
    });
  });
});
