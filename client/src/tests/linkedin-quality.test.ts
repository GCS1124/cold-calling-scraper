import { describe, expect, it } from 'vitest';

import type { Lead } from '../types/lead';
import {
  getLinkedInLeadReadiness,
  getLinkedInQualityTier,
  getLinkedInRankingScore,
  isContactReadyLinkedInLead,
  isEvidenceBackedLinkedInLead,
  isHighFitLinkedInLead,
} from '../utils/linkedin-quality';

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

describe('LinkedIn result quality helpers', () => {
  it('prioritizes publicly listed contact details without changing match confidence', () => {
    const contactReady = {
      ...baseLead,
      hasEmail: true,
      hasPhone: true,
      email: 'hello@example.test',
      mobile: '+1 512 555 0100',
    };

    expect(getLinkedInLeadReadiness(contactReady)).toBe('email-and-phone');
    expect(isContactReadyLinkedInLead(contactReady)).toBe(true);
    expect(
      getLinkedInRankingScore(contactReady, 'contact-ready'),
    ).toBeGreaterThan(getLinkedInRankingScore(baseLead, 'contact-ready'));
  });

  it('recognizes evidence-backed profiles and falls back to profile-only readiness', () => {
    expect(getLinkedInLeadReadiness(baseLead)).toBe('profile-only');
    expect(isContactReadyLinkedInLead(baseLead)).toBe(false);
    expect(isEvidenceBackedLinkedInLead(baseLead)).toBe(false);
    expect(
      isEvidenceBackedLinkedInLead({
        ...baseLead,
        publicEvidence: { profileSnippet: 'Public result excerpt.' },
      }),
    ).toBe(true);
  });

  it('assigns research tiers from public fit and corroboration signals', () => {
    expect(
      getLinkedInQualityTier({
        ...baseLead,
        publicEvidence: { profileSnippet: 'Public result excerpt.' },
      }),
    ).toBe('B');
    expect(
      getLinkedInQualityTier({
        ...baseLead,
        confidence: 94,
        publicEvidence: { profileSnippet: 'Public result excerpt.' },
        matchSignals: {
          ...baseLead.matchSignals!,
          queryMatches: 3,
          publicSources: 2,
        },
      }),
    ).toBe('A');
    expect(
      getLinkedInQualityTier({
        ...baseLead,
        confidence: 74,
        publicEvidence: undefined,
      }),
    ).toBe('C');
  });
});
