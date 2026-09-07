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
      contactSourceUrl: 'https://publicdental.example/contact',
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
    sourceMode: 'linkedin',
    phonePolicy: {
      required: true,
      evidence: 'public_phone_evidence',
      lineType: 'not_checked',
      reachability: 'not_checked',
      personalOwnership: 'not_checked',
      emailDelivery: 'not_checked',
    },
    limitations: ['Provider coverage is execution-specific.'],
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
      providerCoverage: [{
        providerId: 'linkedin-public-search',
        providerName: 'Public LinkedIn Search',
        status: 'returned',
        leadCount: 1,
      }],
    },
    totals: { total: 1, withEmail: 1, withPhone: 1, withWebsite: 1 },
    providerWarnings: [],
  },
};

describe('buildResearchDossier', () => {
  it('returns source-backed lead details and honest limitations', () => {
    const dossier = buildResearchDossier(response);

    expect(dossier.leads[0]?.evidence?.[0]?.sourceUrl).toBe('https://publicdental.example');
    expect(dossier.contractVersion).toBe(2);
    expect(dossier.sourceMode).toBe('linkedin');
    expect(dossier.phonePolicy.required).toBe(true);
    expect(dossier.providerCoverage[0]?.providerId).toBe('linkedin-public-search');
    expect(dossier.coverage).toMatchObject({ observed: 1, requested: 50, found: 1, excludedByPhone: 0, withPhone: 1 });
    expect(dossier.qualitySummary).toMatchObject({
      eligible: 1,
      needsReview: 0,
      freshPhoneObservations: 1,
      tierCounts: { supported: 1 },
    });
    expect(dossier.limitations).toContain('Provider coverage is execution-specific.');
    expect(dossier.limitations.join(' ')).toContain('public');
  });

  it('can scope a dossier to one lead', () => {
    expect(buildResearchDossier(response, 'lead-1').leads).toHaveLength(1);
    expect(buildResearchDossier(response, 'missing').leads).toHaveLength(0);
  });

  it('does not expose a legacy phone whose only evidence identifies a website', () => {
    const dossier = buildResearchDossier({ ...response, leads: response.leads.map((lead) => ({ ...lead, contactSourceUrl: undefined })) });
    expect(dossier.leads).toEqual([]);
    expect(dossier.coverage.found).toBe(0);
  });
});
