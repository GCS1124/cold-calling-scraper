import { describe, expect, it } from 'vitest';

import { buildExportRows } from '../utils/export';
import type { Lead } from '../types/lead';

const lead: Lead = {
  id: 'linkedin-export-lead',
  name: 'Public LinkedIn Lead',
  organizationName: 'Example Business',
  decisionMakerName: 'Public LinkedIn Lead',
  decisionMakerRole: 'Owner',
  decisionMakerSourceUrl: 'https://www.linkedin.com/in/public-lead',
  originalRole: 'Owner at Example Business',
  normalizedRole: 'Owner',
  decisionMaker: true,
  employmentStatus: 'current',
  mobile: '',
  email: '',
  website: 'https://example-business.com',
  listingUrl: 'https://www.linkedin.com/in/public-lead',
  contactSourceUrl: 'https://example-business.com/contact',
  address: 'Austin, TX',
  category: 'Dentist',
  city: 'Austin',
  source: 'LinkedIn, Public Profile',
  confidence: 91,
  hasEmail: false,
  hasPhone: false,
  hasWebsite: true,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: '2026-09-03T00:00:00.000Z',
};

describe('lead export rows', () => {
  it('keeps business, profile, and contact-source URLs separate', () => {
    expect(
      buildExportRows([lead], [
        'name',
        'organizationName',
        'decisionMakerName',
        'decisionMakerRole',
        'decisionMakerSourceUrl',
        'originalRole',
        'normalizedRole',
        'decisionMaker',
        'employmentStatus',
        'website',
        'listingUrl',
        'contactSourceUrl',
        'confidence',
        'source',
      ]),
    ).toEqual([
      {
        name: 'Public LinkedIn Lead',
        organizationName: 'Example Business',
        decisionMakerName: 'Public LinkedIn Lead',
        decisionMakerRole: 'Owner',
        decisionMakerSourceUrl: 'https://www.linkedin.com/in/public-lead',
        originalRole: 'Owner at Example Business',
        normalizedRole: 'Owner',
        decisionMaker: 'Yes',
        employmentStatus: 'current',
        website: 'https://example-business.com',
        listingUrl: 'https://www.linkedin.com/in/public-lead',
        contactSourceUrl: 'https://example-business.com/contact',
        confidence: 91,
        source: 'LinkedIn, Public Profile',
      },
    ]);
  });
});
