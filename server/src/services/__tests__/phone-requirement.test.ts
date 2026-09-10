import { describe, expect, it } from 'vitest';

import type { Lead } from '../../types/lead';
import { enforcePhoneRequirement, isPhoneQualifiedLead } from '../phone-requirement';

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'public-phone-lead',
  name: 'Public Phone Dental',
  mobile: '+1 512 555 0101',
  email: '',
  website: 'https://public-phone-dental.example',
  listingUrl: 'https://www.google.com/maps/search/?api=1&query=Public+Phone+Dental',
  address: 'Austin, TX',
  category: 'Dentist',
  city: 'Austin, TX',
  source: 'Google Places',
  confidence: 90,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: false,
  scrapedAt: '2026-09-04T00:00:00.000Z',
  ...overrides,
});

describe('phone requirement', () => {
  it('requires a public source URL in addition to a validated phone', () => {
    expect(isPhoneQualifiedLead(makeLead())).toBe(true);
    expect(
      isPhoneQualifiedLead(
        makeLead({ listingUrl: undefined, contactSourceUrl: undefined, evidence: undefined }),
      ),
    ).toBe(false);
  });

  it('accepts a phone sourced from a public evidence document', () => {
    expect(
      isPhoneQualifiedLead(
        makeLead({
          listingUrl: undefined,
          evidence: [
            {
              sourceUrl: 'https://public-phone-dental.example/contact',
              sourceName: 'Public website contact page',
              claim: 'The site publishes the phone number.',
              status: 'confirmed',
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('reports excluded leads when the mandatory phone gate is enabled', () => {
    const result = enforcePhoneRequirement(
      [makeLead(), makeLead({ id: 'unproven-phone', listingUrl: undefined })],
      {
        companyType: 'Dentist',
        city: 'Austin, TX',
        count: 50,
        phoneRequired: true,
      },
    );

    expect(result.leads).toHaveLength(1);
    expect(result.excludedCount).toBe(1);
    expect(result.warning?.message).toContain('Excluded 1 lead');
  });

  it('keeps the gate enabled when an internal caller omits the flag', () => {
    const result = enforcePhoneRequirement(
      [makeLead({ listingUrl: undefined })],
      {
        companyType: 'Dentist',
        city: 'Austin, TX',
        count: 50,
      },
    );

    expect(result.leads).toHaveLength(0);
    expect(result.warning?.providerId).toBe('phone-required');
  });

  it('keeps the requested NotaryCafe, LinkedIn, then GMB plus LinkedIn order', () => {
    const notaryCafe = makeLead({
      id: 'notarycafe-first',
      name: 'NotaryCafe First',
      source: 'NotaryCafe, Indexed Public Search',
      listingUrl: 'https://notarycafe.com/NotaryCafe.First',
      contactSourceUrl: 'https://notarycafe.com/NotaryCafe.First',
      website: '',
      confidence: 55,
    });
    const linkedIn = makeLead({
      id: 'linkedin-second',
      name: 'LinkedIn Second',
      source: 'LinkedIn, Public Profile',
      listingUrl: 'https://linkedin.com/in/linkedin-second',
      contactEvidence: [{
        field: 'phone',
        value: '+1 512 555 0101',
        sourceUrl: 'https://linkedin.com/in/linkedin-second',
        sourceName: 'LinkedIn, Public Profile',
        sourceKind: 'public_snippet',
        association: 'person',
      }],
      confidence: 75,
    });
    const fused = makeLead({
      id: 'gmb-linkedin-third',
      name: 'GMB LinkedIn Third',
      source: 'LinkedIn, Public Profile, Google Places',
      listingUrl: 'https://linkedin.com/in/gmb-linkedin-third',
      contactSourceUrl: 'https://www.google.com/maps/place/gmb-linkedin-third',
      confidence: 95,
    });

    const result = enforcePhoneRequirement(
      [fused, linkedIn, notaryCafe],
      { companyType: 'Notary Public', city: 'Austin, TX', count: 50, phoneRequired: true },
    );

    expect(result.leads.map((lead) => lead.id)).toEqual([
      'notarycafe-first',
      'linkedin-second',
      'gmb-linkedin-third',
    ]);
  });

  it('keeps all four AI source groups in the required sequence', () => {
    const notaryCafe = makeLead({
      id: 'sequence-notarycafe',
      source: 'NotaryCafe, Indexed Public Search',
      listingUrl: 'https://notarycafe.com/Sequence.Notary',
      contactSourceUrl: 'https://notarycafe.com/Sequence.Notary',
    });
    const pureLinkedIn = makeLead({
      id: 'sequence-linkedin',
      source: 'LinkedIn, Public Profile',
      listingUrl: 'https://linkedin.com/in/sequence-linkedin',
      contactEvidence: [{
        field: 'phone',
        value: '+1 512 555 0101',
        sourceUrl: 'https://linkedin.com/in/sequence-linkedin',
        sourceName: 'LinkedIn, Public Profile',
        sourceKind: 'public_snippet',
        association: 'person',
      }],
    });
    const fused = makeLead({
      id: 'sequence-fusion',
      source: 'LinkedIn, Public Profile, Google Business',
      listingUrl: 'https://linkedin.com/in/sequence-fusion',
      contactSourceUrl: 'https://www.google.com/maps/place/sequence-fusion',
    });
    const other = makeLead({
      id: 'sequence-other',
      source: 'OpenStreetMap, Public Website',
      listingUrl: 'https://www.openstreetmap.org/node/sequence-other',
    });

    const result = enforcePhoneRequirement(
      [other, fused, pureLinkedIn, notaryCafe],
      {
        companyType: 'HVAC contractor',
        sourceMode: 'ai',
        city: 'Austin, TX',
        count: 50,
        phoneRequired: true,
      },
    );

    expect(result.leads.map((lead) => lead.id)).toEqual([
      'sequence-notarycafe',
      'sequence-linkedin',
      'sequence-fusion',
      'sequence-other',
    ]);
  });
});
