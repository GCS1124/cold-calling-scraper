import { describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';
import { enrichWebsiteCandidates } from '../business-website-enrichment';

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'website-candidate',
  name: 'Northstar Dental',
  mobile: '',
  email: '',
  website: 'https://northstar.example',
  category: 'Dentist',
  city: 'Austin, TX',
  source: 'Google Places',
  confidence: 70,
  hasEmail: false,
  hasPhone: false,
  hasWebsite: true,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: new Date().toISOString(),
  ...overrides,
});

describe('enrichWebsiteCandidates', () => {
  it('only spends the bounded website budget on phone-unqualified, not-yet-crawled leads', async () => {
    const enrichLead = vi.fn(async (lead: Lead) => ({
      lead: { ...lead, crawlAttempts: 1, websiteAssessment: { version: 1 as const, status: 'probable' as const, score: 20, canonicalHost: 'northstar.example', sourceUrl: lead.website!, observedAt: new Date().toISOString(), robots: 'allowed' as const, reasons: ['Public phone found.'], gaps: [] } },
      warnings: [],
    }));

    const result = await enrichWebsiteCandidates({
      leads: [
        makeLead({ id: 'missing-phone' }),
        makeLead({ id: 'already-crawled', crawlAttempts: 1 }),
        makeLead({
          id: 'phone-ready',
          mobile: '+1 512 555 0101',
          hasPhone: true,
          verifiedPhone: true,
          contactEvidence: [{
            field: 'phone',
            value: '+1 512 555 0101',
            sourceUrl: 'https://northstar.example',
            sourceName: 'Public business website',
            sourceKind: 'business_website',
            association: 'business',
          }],
        }),
      ],
      enrichLead,
      deadlineMs: Date.now() + 5_000,
      concurrency: 2,
    });

    expect(enrichLead).toHaveBeenCalledTimes(1);
    expect(result.attemptedCount).toBe(1);
    expect(result.leads[0]?.id).toBe('missing-phone');
  });

  it('does not start a new crawl after the deadline', async () => {
    const enrichLead = vi.fn(async (lead: Lead) => ({ lead, warnings: [] }));
    let now = 10;

    const result = await enrichWebsiteCandidates({
      leads: [makeLead()],
      enrichLead,
      deadlineMs: 10,
      now: () => now,
    });

    now += 1;
    expect(enrichLead).not.toHaveBeenCalled();
    expect(result.candidateCount).toBe(1);
  });

  it('can enrich a phone-qualified business for a missing public person name', async () => {
    const enrichLead = vi.fn(async (lead: Lead) => ({
      lead: { ...lead, decisionMakerName: 'Jordan Lee' },
      warnings: [],
    }));

    const result = await enrichWebsiteCandidates({
      leads: [
        makeLead({
          mobile: '+1 512 555 0101',
          hasPhone: true,
          verifiedPhone: true,
        }),
      ],
      enrichLead,
      includeDecisionMakerNames: true,
      deadlineMs: Date.now() + 5_000,
    });

    expect(enrichLead).toHaveBeenCalledOnce();
    expect(result.leads[0]?.decisionMakerName).toBe('Jordan Lee');
  });
});
