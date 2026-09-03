import { describe, expect, it } from 'vitest';

import type { Lead } from '../types/lead';
import { isHighFitLinkedInLead } from '../utils/linkedin-quality';

const baseLead: Lead = {
  id: 'linkedin-quality-test',
  name: 'Public Dentist Profile',
  category: 'Dentist',
  city: 'Austin, TX',
  source: 'LinkedIn, Public Profile',
  confidence: 90,
  hasEmail: false,
  hasPhone: false,
  hasWebsite: false,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: '2026-09-03T00:00:00.000Z',
  matchSignals: {
    queryMatches: 2,
    publicSources: 1,
    categoryMatched: true,
    roleMatched: true,
    locationMatched: true,
  },
};

describe('isHighFitLinkedInLead', () => {
  it('accepts a high-confidence profile with category, role, and location proof', () => {
    expect(isHighFitLinkedInLead(baseLead)).toBe(true);
  });

  it('requires public location proof', () => {
    expect(
      isHighFitLinkedInLead({
        ...baseLead,
        matchSignals: { ...baseLead.matchSignals!, locationMatched: false },
      }),
    ).toBe(false);
  });

  it('rejects an explicit category mismatch', () => {
    expect(
      isHighFitLinkedInLead({
        ...baseLead,
        matchSignals: { ...baseLead.matchSignals!, categoryMatched: false },
      }),
    ).toBe(false);
  });

  it('accepts corroborated public results when role proof is incomplete', () => {
    expect(
      isHighFitLinkedInLead({
        ...baseLead,
        matchSignals: {
          ...baseLead.matchSignals!,
          publicSources: 2,
          roleMatched: false,
        },
      }),
    ).toBe(true);
  });

  it('requires at least 85% confidence', () => {
    expect(isHighFitLinkedInLead({ ...baseLead, confidence: 84 })).toBe(false);
  });
});
