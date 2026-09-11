import { describe, expect, it } from 'vitest';

import type { Lead } from '../../types/lead';
import { mergeLinkedInWithPublicListingsWithDiagnostics } from '../public-entity-matching';

const person = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'linkedin-avery',
  name: 'Avery Smith',
  organizationName: 'Northstar Dental',
  originalRole: 'Owner',
  mobile: '',
  email: '',
  website: '',
  listingUrl: 'https://www.linkedin.com/in/avery-smith',
  category: 'Dentist',
  city: 'Austin, TX',
  stateCode: 'TX',
  source: 'Public LinkedIn Search',
  confidence: 82,
  hasEmail: false,
  hasPhone: false,
  hasWebsite: false,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: '2026-09-11T00:00:00.000Z',
  ...overrides,
});

const listing = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'gmb-northstar',
  name: 'Northstar Dental',
  mobile: '+1 512 555 0101',
  email: '',
  website: '',
  listingUrl: 'https://www.google.com/maps/place/northstar-dental',
  contactSourceUrl: 'https://www.google.com/maps/place/northstar-dental',
  contactEvidence: [{
    field: 'phone',
    value: '+1 512 555 0101',
    sourceUrl: 'https://www.google.com/maps/place/northstar-dental',
    sourceName: 'Google Business',
    sourceKind: 'business_listing',
    association: 'business',
    observedAt: '2026-09-11T00:00:00.000Z',
  }],
  category: 'Dentist',
  city: 'Austin, TX',
  stateCode: 'TX',
  source: 'Google Business (GMB) listings',
  confidence: 88,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: false,
  verifiedPhone: true,
  verifiedEmail: false,
  scrapedAt: '2026-09-11T00:00:00.000Z',
  ...overrides,
});

describe('strict public LinkedIn and Google Business fusion', () => {
  it('retains former public employment in review instead of producing a fusion lead', () => {
    const result = mergeLinkedInWithPublicListingsWithDiagnostics(
      [person({ employmentStatus: 'former' })],
      [listing()],
    );

    expect(result.fusedLeadIds).toEqual([]);
    expect(result.reviewCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'former_or_conflicting', relatedLeadIds: ['linkedin-avery', 'gmb-northstar'] }),
    ]));
  });

  it('rejects two equally credible business matches as ambiguous', () => {
    const result = mergeLinkedInWithPublicListingsWithDiagnostics(
      [person()],
      [
        listing({ id: 'gmb-northstar-a', mobile: '+1 512 555 0101' }),
        listing({
          id: 'gmb-northstar-b',
          mobile: '+1 512 555 0102',
          listingUrl: 'https://www.google.com/maps/place/northstar-dental-b',
          contactSourceUrl: 'https://www.google.com/maps/place/northstar-dental-b',
          contactEvidence: [{
            field: 'phone',
            value: '+1 512 555 0102',
            sourceUrl: 'https://www.google.com/maps/place/northstar-dental-b',
            sourceName: 'Google Business',
            sourceKind: 'business_listing',
            association: 'business',
          }],
        }),
      ],
    );

    expect(result.fusedLeadIds).toEqual([]);
    expect(result.reviewCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'organization_ambiguous' }),
    ]));
  });

  it('creates a fusion only with a strict match and a public business route', () => {
    const result = mergeLinkedInWithPublicListingsWithDiagnostics([person()], [listing()]);

    expect(result.fusedLeadIds).toEqual(['linkedin-avery']);
    expect(result.reviewCandidates).toEqual([]);
    expect(result.leads[0]).toMatchObject({
      decisionMakerName: 'Avery Smith',
      mobile: '+1 512 555 0101',
      decisionMakerPhonePair: {
        status: 'paired',
        phoneAssociation: 'business',
      },
    });
  });
});
