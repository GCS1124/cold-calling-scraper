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
});
