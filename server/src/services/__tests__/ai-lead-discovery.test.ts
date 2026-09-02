import { describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';
import { createAiLeadDiscovery } from '../ai-lead-discovery';
import type { NormalizedUsLocation } from '../us-location';

const location: NormalizedUsLocation = {
  mode: 'local',
  label: 'Austin, TX',
  city: 'Austin',
  stateCode: 'TX',
  postalCode: '78701',
  lat: 30.2672,
  lon: -97.7431,
  boundingBox: {
    south: 30,
    west: -98,
    north: 31,
    east: -97,
  },
  warnings: [],
};

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'linkedin-lead-1',
  name: 'Avery Smith',
  headline: 'Owner at Austin Dental Studio',
  mobile: '',
  email: '',
  website: 'https://austindentalstudio.com',
  address: 'Austin, TX',
  category: 'Dentist',
  city: 'Austin',
  source: 'LinkedIn, Public Profile',
  confidence: 88,
  sourceScore: 86,
  listingUrl: 'https://linkedin.com/in/avery-smith',
  hasEmail: false,
  hasPhone: false,
  hasWebsite: true,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: '2026-09-02T00:00:00.000Z',
  ...overrides,
});

describe('free AI lead discovery', () => {
  it('uses public LinkedIn and website sources without commercial credentials', async () => {
    const discoverLinkedin = vi.fn().mockResolvedValue({
      leads: [makeLead()],
      warnings: [],
      blocked: false,
      coverage: {
        queriesAttempted: 12,
        providersChecked: 3,
        providersPaused: 0,
        acceptedCandidates: 1,
      },
    });
    const enrichPublicContacts = vi.fn().mockResolvedValue({
      leads: [
        makeLead({
          email: 'hello@austindentalstudio.com',
          hasEmail: true,
          verifiedEmail: true,
        }),
      ],
      warnings: [],
      enrichedCount: 1,
    });

    const discovery = createAiLeadDiscovery({
      discoverLinkedin: discoverLinkedin as never,
      enrichPublicContacts: enrichPublicContacts as never,
    });
    const result = await discovery({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(discoverLinkedin).toHaveBeenCalledTimes(1);
    expect(enrichPublicContacts).toHaveBeenCalledTimes(1);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.email).toBe('hello@austindentalstudio.com');
    expect(result.aiAssistance).toBe('disabled');
    expect(result.publicCoverage?.providersChecked).toBe(3);
    expect(result.warnings[0]?.message).toContain('does not use paid databases');
    expect(result.coverage.find((entry) => entry.providerId === 'apollo-audit')?.status).toBe(
      'not_configured',
    );
    expect(result.coverage.find((entry) => entry.providerId === 'rocketreach-audit')?.message).toContain(
      'used or inferred',
    );
  });

  it('keeps public results when website enrichment is unavailable', async () => {
    const publicLead = makeLead();
    const discovery = createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [publicLead],
        warnings: [],
        blocked: false,
      }) as never,
      enrichPublicContacts: vi.fn().mockRejectedValue(new Error('public site timeout')) as never,
    });

    const result = await discovery({
      request: { companyType: 'HVAC contractor', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.listingUrl).toBe(publicLead.listingUrl);
    expect(result.coverage.find((entry) => entry.providerId === 'public-website-enrichment')?.status).toBe(
      'failed',
    );
    expect(result.warnings.some((warning) => warning.message.includes('public site timeout'))).toBe(
      true,
    );
  });

  it('does not add unverified profiles when public search is blocked', async () => {
    const result = await createAiLeadDiscovery({
      discoverLinkedin: vi.fn().mockResolvedValue({
        leads: [],
        warnings: [],
        blocked: true,
      }) as never,
    })({
      request: { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      location,
    });

    expect(result.leads).toEqual([]);
    expect(result.warnings.some((warning) => /unverified|fabricated/i.test(warning.message))).toBe(
      true,
    );
    expect(result.coverage.find((entry) => entry.providerId === 'linkedin-public-search')?.status).toBe(
      'failed',
    );
  });
});
