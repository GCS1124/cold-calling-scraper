import { describe, expect, it } from 'vitest';

import { deduplicateLeads } from '../lead-deduplication';
import { enrichLead } from '../lead-validation';
import type { Lead } from '../../types/lead';

describe('enrichLead', () => {
  it('normalizes websites and US phone numbers while updating validation flags', () => {
    const lead: Lead = {
      id: 'lead-1',
      name: 'Northstar Systems',
      mobile: '5125550187',
      email: 'sales@northstar.io',
      website: 'northstar.io',
      address: 'South Congress',
      category: 'Dental Clinics',
      city: 'Austin, TX',
      source: 'OpenStreetMap',
      confidence: 0,
      qualified: false,
      hasEmail: false,
      hasPhone: false,
      hasWebsite: false,
      verifiedPhone: false,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    };

    const enriched = enrichLead(lead);

    expect(enriched.mobile).toBe('+1 512 555 0187');
    expect(enriched.website).toBe('https://northstar.io');
    expect(enriched.hasEmail).toBe(true);
    expect(enriched.hasPhone).toBe(true);
    expect(enriched.hasWebsite).toBe(true);
    expect(enriched.verifiedEmail).toBe(true);
    expect(enriched.verifiedPhone).toBe(true);
    expect(enriched.confidence).toBeGreaterThan(80);
  });

  it('rejects syntactically matched but polluted email domains from qualification', () => {
    const lead: Lead = {
      id: 'lead-2',
      name: 'Parmer Lane Orthodontics',
      mobile: '+1 512 793 9325',
      email: '9325mailinfo@parmerlaneortho.orghomeaboutpatient',
      website: 'https://www.parmerlaneortho.com/',
      address: '',
      category: 'Dental Clinics',
      city: 'Austin, TX',
      source: 'Website Crawl',
      confidence: 80,
      qualified: false,
      hasEmail: false,
      hasPhone: false,
      hasWebsite: false,
      verifiedPhone: false,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    };

    const enriched = enrichLead(lead);

    expect(enriched.hasEmail).toBe(true);
    expect(enriched.verifiedEmail).toBe(false);
    expect(enriched.qualified).toBe(false);
    expect(enriched.rejectionReason).toBe('missing_email');
  });
});

describe('deduplicateLeads', () => {
  it('merges overlapping leads and keeps the richest fields', () => {
    const leads: Lead[] = [
      {
        id: 'lead-1',
        name: 'Orbit Components',
        mobile: '',
        email: '',
        website: 'orbitcomponents.com',
        address: 'East Austin',
        category: 'Dental Clinics',
        city: 'Austin, TX',
        source: 'OpenStreetMap',
        confidence: 65,
        qualified: false,
        hasEmail: false,
        hasPhone: false,
        hasWebsite: true,
        verifiedPhone: false,
        verifiedEmail: false,
        scrapedAt: '2026-04-21T00:00:00.000Z',
      },
      {
        id: 'lead-2',
        name: 'Orbit Components LLC',
        mobile: '5125550109',
        email: 'info@orbitcomponents.com',
        website: '',
        address: 'East Austin, Texas',
        category: 'Dental Clinics',
        city: 'Austin, TX',
        source: 'Website Crawl',
        confidence: 72,
        qualified: false,
        hasEmail: true,
        hasPhone: true,
        hasWebsite: false,
        verifiedPhone: false,
        verifiedEmail: false,
        scrapedAt: '2026-04-21T00:00:00.000Z',
      },
    ];

    const merged = deduplicateLeads(leads);

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Orbit Components');
    expect(merged[0].email).toBe('info@orbitcomponents.com');
    expect(merged[0].website).toBe('orbitcomponents.com');
    expect(merged[0].mobile).toBe('5125550109');
    expect(merged[0].source).toBe('OpenStreetMap, Website Crawl');
    expect(merged[0].confidence).toBeGreaterThanOrEqual(72);
  });
});
