import { describe, expect, it } from 'vitest';

import type { Lead } from '../../types/lead';
import { attachLeadResearchSignals, buildLeadEvidence, scoreLeadResearch } from '../lead-research-signals';

const lead: Lead = {
  id: 'public-dental-owner',
  name: 'Austin Dental Studio',
  headline: 'Owner at Austin Dental Studio',
  mobile: '+1 512 555 0101',
  email: 'hello@austindentalstudio.com',
  website: 'https://austindentalstudio.com',
  contactSourceUrl: 'https://austindentalstudio.com/contact',
  address: 'Austin, TX',
  category: 'Dentist',
  city: 'Austin, TX',
  source: 'LinkedIn, Public Web, Website Crawl',
  confidence: 88,
  sourceScore: 86,
  matchSignals: {
    queryMatches: 3,
    publicSources: 2,
    categoryMatched: true,
    ownerMatched: true,
    roleMatched: true,
    locationMatched: true,
  },
  listingUrl: 'https://www.linkedin.com/in/austin-dental-owner',
  hasEmail: true,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: true,
  scrapedAt: '2026-09-04T00:00:00.000Z',
};

describe('lead research signals', () => {
  it('creates source-backed evidence for public listing, website, and phone', () => {
    const evidence = buildLeadEvidence(lead);

    expect(evidence).toHaveLength(3);
    expect(evidence.every((item) => item.status === 'confirmed')).toBe(true);
    expect(evidence.some((item) => item.sourceUrl === lead.contactSourceUrl)).toBe(true);
  });

  it('scores trust, fit, contactability, and priority independently', () => {
    const scores = scoreLeadResearch(lead);

    expect(scores.trust).toBeGreaterThan(70);
    expect(scores.fit).toBe(100);
    expect(scores.contactability).toBe(100);
    expect(scores.priority).toBeGreaterThanOrEqual(80);
    expect(scores.reasons).toEqual(
      expect.arrayContaining(['Phone validated', 'Owner or founder signal']),
    );
  });

  it('attaches scores and preserves existing evidence', () => {
    const existing = {
      sourceUrl: 'https://registry.example/public-record',
      sourceName: 'Public registry',
      claim: 'Public registry lists the organization.',
      status: 'corroborated' as const,
    };
    const enriched = attachLeadResearchSignals({ ...lead, evidence: [existing] });

    expect(enriched.evidence).toEqual(expect.arrayContaining([existing]));
    expect(enriched.evidence).toHaveLength(4);
    expect(enriched.scores?.priority).toBeGreaterThan(0);
  });
});
