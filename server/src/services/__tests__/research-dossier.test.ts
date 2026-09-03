import { describe, expect, it } from 'vitest';

import type { SearchResponse } from '../../types/search';
import { buildResearchDossier } from '../research-dossier';

const response: SearchResponse = {
  searchId: 'dossier-search-1',
  leads: [
    {
      id: 'lead-1',
      name: 'Public Dental Owner',
      headline: 'Owner at Public Dental',
      employmentStatus: 'probable',
      mobile: '+1 512 555 0101',
      email: 'hello@publicdental.example',
      website: 'https://publicdental.example',
      category: 'Dentist',
      city: 'Austin',
      source: 'LinkedIn, Website Crawl',
      confidence: 90,
      hasEmail: true,
      hasPhone: true,
      hasWebsite: true,
      verifiedPhone: true,
      verifiedEmail: true,
      scrapedAt: '2026-09-04T00:00:00.000Z',
      evidence: [
        {
          sourceUrl: 'https://publicdental.example',
          sourceName: 'Public website',
          claim: 'A public business website was found.',
          status: 'confirmed',
        },
      ],
    },
  ],
  meta: {
    query: 'Dentist in Austin, TX',
    locationLabel: 'Austin, TX',
    researchDepth: 'verified',
    status: 'complete',
    progress: {
      discovered: 1,
      enriched: 1,
      totalCandidates: 1,
      requestedCount: 50,
      foundCount: 1,
      duplicatesRemoved: 0,
      currentSource: 'Complete',
      batchesCompleted: 1,
      estimatedRemaining: 49,
    },
    totals: { total: 1, withEmail: 1, withPhone: 1, withWebsite: 1 },
    providerWarnings: [],
  },
};

describe('buildResearchDossier', () => {
  it('returns source-backed lead details and honest limitations', () => {
    const dossier = buildResearchDossier(response);

    expect(dossier.leads[0]?.evidence?.[0]?.sourceUrl).toBe('https://publicdental.example');
    expect(dossier.coverage).toMatchObject({ requested: 50, found: 1, withPhone: 1 });
    expect(dossier.limitations.join(' ')).toContain('public');
  });

  it('can scope a dossier to one lead', () => {
    expect(buildResearchDossier(response, 'lead-1').leads).toHaveLength(1);
    expect(buildResearchDossier(response, 'missing').leads).toHaveLength(0);
  });
});
