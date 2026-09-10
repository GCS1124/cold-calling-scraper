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
    expect(enriched.rejectionReason).toBe('missing_email');
  });

  it('does not count a LinkedIn profile listing as a business website', () => {
    const enriched = enrichLead({
      id: 'linkedin-lead',
      name: 'Jordan Lee',
      mobile: '',
      email: '',
      website: '',
      address: '',
      category: 'Dentist',
      city: 'Austin, TX',
      source: 'LinkedIn',
      confidence: 80,
      listingUrl: 'https://linkedin.com/in/jordan-lee',
      hasEmail: false,
      hasPhone: false,
      hasWebsite: true,
      verifiedPhone: false,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    });

    expect(enriched.hasWebsite).toBe(false);
    expect(enriched.website).toBe('');
  });

  it('does not count a legacy LinkedIn public profile listing as a business website', () => {
    const enriched = enrichLead({
      id: 'linkedin-legacy-lead',
      name: 'Olivia Wilson',
      mobile: '',
      email: '',
      website: '',
      address: '',
      category: 'Dentist',
      city: 'Austin, TX',
      source: 'LinkedIn, Public Profile',
      confidence: 80,
      listingUrl: 'https://linkedin.com/pub/olivia-wilson',
      hasEmail: false,
      hasPhone: false,
      hasWebsite: true,
      verifiedPhone: false,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    });

    expect(enriched.hasWebsite).toBe(false);
    expect(enriched.website).toBe('');
  });

  it('does not count an indexed NotaryCafe profile reference as a business website', () => {
    const enriched = enrichLead({
      id: 'notarycafe-lead',
      name: 'Eric Kaufmann',
      mobile: '+1 303 408 4062',
      email: '',
      website: '',
      address: 'Denver, CO',
      category: 'Notary Public',
      city: 'Denver',
      source: 'NotaryCafe, Indexed Public Search',
      confidence: 72,
      listingUrl: 'https://notarycafe.com/Eric.Kaufmann',
      hasEmail: false,
      hasPhone: true,
      hasWebsite: true,
      verifiedPhone: true,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    });

    expect(enriched.hasWebsite).toBe(false);
    expect(enriched.website).toBe('');
  });

  it('does not count a NotaryCafe profile accidentally supplied in website as a business website', () => {
    const enriched = enrichLead({
      id: 'notarycafe-website-lead',
      name: 'Eric Kaufmann',
      mobile: '+1 303 408 4062',
      email: '',
      website: 'https://notarycafe.com/Eric.Kaufmann',
      address: 'Denver, CO',
      category: 'Notary Public',
      city: 'Denver',
      source: 'NotaryCafe, Indexed Public Search',
      confidence: 72,
      listingUrl: 'https://notarycafe.com/Eric.Kaufmann',
      hasEmail: false,
      hasPhone: true,
      hasWebsite: true,
      verifiedPhone: true,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    });

    expect(enriched.hasWebsite).toBe(false);
    expect(enriched.website).toBe('https://notarycafe.com/Eric.Kaufmann');
  });

  it('does not treat a lookalike domain as a LinkedIn profile listing', () => {
    const enriched = enrichLead({
      id: 'lookalike-linkedin-lead',
      name: 'Jordan Lee',
      mobile: '',
      email: '',
      website: '',
      address: '',
      category: 'Dentist',
      city: 'Austin, TX',
      source: 'Public Web',
      confidence: 80,
      listingUrl: 'https://notlinkedin.com/in/jordan-lee',
      hasEmail: false,
      hasPhone: false,
      hasWebsite: false,
      verifiedPhone: false,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    });

    expect(enriched.hasWebsite).toBe(true);
  });

  it('drops private-network website and listing URLs at the lead boundary', () => {
    const enriched = enrichLead({
      id: 'unsafe-url-lead',
      name: 'Unsafe URL Lead',
      mobile: '',
      email: '',
      website: 'http://127.0.0.1/admin',
      address: '',
      category: 'Dentist',
      city: 'Austin, TX',
      source: 'Public Web',
      confidence: 40,
      listingUrl: 'http://[::ffff:127.0.0.1]/internal',
      hasEmail: false,
      hasPhone: false,
      hasWebsite: true,
      verifiedPhone: false,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    });

    expect(enriched.website).toBe('');
    expect(enriched.listingUrl).toBeUndefined();
    expect(enriched.hasWebsite).toBe(false);
  });

  it('filters unsafe contact, evidence, and social URLs before export', () => {
    const enriched = enrichLead({
      id: 'unsafe-evidence-lead',
      name: 'Evidence Lead',
      mobile: '',
      email: '',
      website: 'https://evidence.example',
      contactSourceUrl: 'http://localhost/contact',
      decisionMakerSourceUrl: 'http://[::ffff:7f00:1]/person',
      publicSocialLinks: [
        { platform: 'Other', url: 'http://127.0.0.1/social' },
        { platform: 'Other', url: 'https://evidence.example/social' },
      ],
      evidence: [
        {
          sourceUrl: 'http://192.168.1.5/internal',
          sourceName: 'Private',
          claim: 'Do not export this',
          status: 'unknown',
        },
        {
          sourceUrl: 'https://evidence.example/about',
          sourceName: 'Public page',
          claim: 'Publicly visible business evidence',
          status: 'confirmed',
        },
      ],
      address: 'Austin, TX',
      category: 'Dentist',
      city: 'Austin, TX',
      source: 'Public Web',
      confidence: 40,
      hasEmail: false,
      hasPhone: false,
      hasWebsite: true,
      verifiedPhone: false,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    });

    expect(enriched.contactSourceUrl).toBeUndefined();
    expect(enriched.decisionMakerSourceUrl).toBeUndefined();
    expect(enriched.publicSocialLinks).toEqual([
      { platform: 'Other', url: 'https://evidence.example/social' },
    ]);
    expect(enriched.evidence?.map((item) => item.sourceUrl)).toEqual([
      'https://evidence.example/about',
      'https://evidence.example',
    ]);
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
