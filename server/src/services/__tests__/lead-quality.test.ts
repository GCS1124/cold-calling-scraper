import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContactEvidence } from '../../../../shared/lead-quality';
import type { Lead } from '../../types/lead';
import { collectContactEvidence, getContactEvidence, mergeContactEvidence } from '../contact-evidence';
import { assessLeadQuality } from '../lead-quality';
import { enrichLead } from '../lead-validation';
import { enforcePhoneRequirement, isPhoneQualifiedLead } from '../phone-requirement';
import { bridgeLinkedInWithPublicListings } from '../public-entity-matching';
import { deduplicateLeads } from '../lead-deduplication';
import { enrichLeadFromWebsite } from '../website-enrichment';
import { httpClient } from '../../utils/http-client';

const now = Date.parse('2026-09-07T12:00:00Z');
const observation = (overrides: Partial<ContactEvidence> = {}): ContactEvidence => ({
  field: 'phone', value: '+15125550101', sourceUrl: 'https://alpha-dental.com/contact',
  sourceName: 'Business website', sourceKind: 'business_website', association: 'business',
  observedAt: new Date(now).toISOString(), ...overrides,
});
const lead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'alpha', name: 'Alpha Dental', mobile: '5125550101', email: '', website: 'https://alpha-dental.com',
  listingUrl: 'https://www.google.com/maps/place/alpha', address: '123 Main St, Austin, TX',
  category: 'Dentist', city: 'Austin', stateCode: 'TX', source: 'Google Places', confidence: 90,
  hasPhone: true, hasEmail: false, hasWebsite: true, verifiedPhone: true, verifiedEmail: false,
  scrapedAt: new Date(now).toISOString(), ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe('public contact quality contract', () => {
  it.each(['http://localhost/contact', 'http://127.0.0.1/contact', 'http://192.168.1.1/contact', 'javascript:alert(1)', 'https://name:secret@alpha-dental.com'])('rejects unsafe contact source %s', (sourceUrl) => {
    expect(isPhoneQualifiedLead(lead({ listingUrl: undefined, contactSourceUrl: sourceUrl }))).toBe(false);
  });

  it('never accepts a LinkedIn identity URL as phone evidence', () => {
    const enriched = enrichLead(lead({ listingUrl: 'https://linkedin.com/in/alpha', source: 'LinkedIn' }));
    expect(enriched.contactEvidence).toEqual([]);
    expect(isPhoneQualifiedLead(enriched)).toBe(false);
    expect(enriched.evidence?.some((item) => item.claim.includes('lists phone'))).toBe(false);
  });

  it('explicit missing or mismatched contact observations cannot fall back to the listing URL', () => {
    expect(isPhoneQualifiedLead(lead({ contactEvidence: [] }))).toBe(false);
    expect(isPhoneQualifiedLead(lead({ contactEvidence: [observation({ value: '+15125550102' })] }))).toBe(false);
  });

  it.each(['invalid', '+44 20 7946 0958', '123'])('rejects invalid US phones even if flags are true: %s', (mobile) => {
    expect(isPhoneQualifiedLead(lead({ mobile }))).toBe(false);
  });

  it('does not let an internal false flag bypass compulsory phone evidence', () => {
    // Exercise malformed persisted/untyped input despite the compile-time true-only contract.
    // @ts-expect-error Phone qualification cannot be disabled, including at runtime.
    expect(enforcePhoneRequirement([lead({ contactEvidence: [] })], { companyType: 'Dentist', city: 'Austin', count: 50, phoneRequired: false }).leads).toEqual([]);
  });

  it.each(['rejected', 'conflicting', 'inferred'] as const)('rejects %s legacy phone claims', (status) => {
    expect(collectContactEvidence(lead({ listingUrl: undefined, evidence: [{ sourceUrl: 'https://alpha-dental.com/contact', sourceName: 'Website', claim: 'Phone 5125550101', status }] }))).toEqual([]);
  });

  it('requires current matching observations on distinct website and listing hosts for corroboration', () => {
    const listing = observation({ sourceUrl: 'https://www.google.com/maps/place/alpha', sourceKind: 'business_listing' });
    const quality = assessLeadQuality(lead({ contactEvidence: [listing, observation()] }), now);
    expect(quality.tier).toBe('corroborated');
    expect(quality.phone).toMatchObject({ lineType: 'unknown', reachability: 'not_checked', association: 'business' });
    expect(assessLeadQuality(lead({ contactEvidence: [listing, observation({ observedAt: '2025-01-01' })] }), now).tier).toBe('supported');
    expect(assessLeadQuality(lead({ contactEvidence: [observation(), observation({ sourceKind: 'business_listing' })] }), now).tier).toBe('supported');
  });

  it('cannot turn snippet repetition into corroborated business evidence', () => {
    const quality = assessLeadQuality(lead({ contactEvidence: [observation({ sourceKind: 'public_snippet' })] }), now);
    expect(quality.tier).toBe('supported');
    expect(quality.score).toBeLessThan(80);
  });

  it('refreshing a record does not refresh stale phone evidence', () => {
    const quality = assessLeadQuality(enrichLead(lead({ contactEvidence: [observation({ observedAt: '2025-01-01' })] })), now);
    expect(quality.freshness).toBe('stale');
    expect(quality.tier).toBe('review');
  });

  it('preserves a newer dated observation when previous time was absent', () => {
    expect(mergeContactEvidence([observation({ observedAt: undefined }), observation()])).toEqual([observation()]);
  });

  it('fails closed on malformed persisted contact evidence instead of breaking polling', () => {
    expect(mergeContactEvidence(null as never)).toEqual([]);
    expect(mergeContactEvidence([null as never, { ...observation(), sourceKind: 'invented' } as never])).toEqual([]);
    expect(isPhoneQualifiedLead(lead({ contactEvidence: null as never }))).toBe(false);
  });

  it('does not treat email syntax as public observation or mailbox verification', () => {
    const quality = assessLeadQuality(enrichLead(lead({ email: 'office@alpha-dental.com' })), now);
    expect(quality.email).toMatchObject({ formatValid: true, publiclyObserved: false, mailbox: 'not_checked' });
  });
});

describe('contact attribution and identity', () => {
  it('shares a business route without collapsing distinct people', () => {
    const people = ['owner', 'manager'].map((id) => lead({ id, name: id, mobile: '', hasPhone: false, verifiedPhone: false, source: 'LinkedIn', listingUrl: `https://linkedin.com/in/${id}`, employmentStatus: 'probable' }));
    const merged = bridgeLinkedInWithPublicListings(people, [enrichLead(lead())]);
    expect(merged.every(isPhoneQualifiedLead)).toBe(true);
    expect(deduplicateLeads(merged)).toHaveLength(2);
    expect(merged.every((item) => getContactEvidence(item, 'phone').every((e) => e.association === 'business'))).toBe(true);
  });

  it('carries a public decision-maker name when a profile matches a business listing', () => {
    const person = lead({
      id: 'public-owner',
      name: 'Avery Smith',
      organizationName: 'Alpha Dental',
      decisionMaker: true,
      originalRole: 'Owner',
      listingUrl: 'https://linkedin.com/in/avery-smith',
      mobile: '',
      hasPhone: false,
      verifiedPhone: false,
      source: 'LinkedIn',
    });

    const merged = bridgeLinkedInWithPublicListings([person], [lead()]);

    expect(merged[0]).toMatchObject({
      organizationName: 'Alpha Dental',
      decisionMakerName: 'Avery Smith',
      decisionMakerRole: 'Owner',
      decisionMakerSourceUrl: 'https://linkedin.com/in/avery-smith',
    });
  });

  it.each(['former', 'conflicting'] as const)('does not attach an employer phone to a %s role', (employmentStatus) => {
    const person = lead({ mobile: '', hasPhone: false, listingUrl: 'https://linkedin.com/in/owner', employmentStatus });
    expect(bridgeLinkedInWithPublicListings([person], [lead()])[0]?.mobile).toBe('');
  });

  it('does not conflate two branches through a company domain and missing-location bridge', () => {
    const branches = deduplicateLeads([
      lead({ id: 'one' }),
      lead({ id: 'unknown', address: '', city: '', listingUrl: undefined }),
      lead({ id: 'two', address: '999 Second St, Austin, TX', listingUrl: 'https://www.google.com/maps/place/other', mobile: '5125550102' }),
    ]);
    expect(branches).toHaveLength(2);
  });

  it('separates branches with the same street number on different streets', () => {
    expect(deduplicateLeads([
      lead(), lead({ id: 'second', address: '123 Second St, Austin, TX', listingUrl: 'https://www.google.com/maps/place/second' }),
    ])).toHaveLength(2);
  });

  it('canonicalizes profile tracking parameters without merging same-name people', () => {
    const profiles = deduplicateLeads([
      lead({ listingUrl: 'https://www.linkedin.com/in/alpha?trk=search' }),
      lead({ listingUrl: 'https://linkedin.com/in/alpha/' }),
      lead({ listingUrl: 'https://linkedin.com/in/different' }),
    ]);
    expect(profiles).toHaveLength(2);
  });

  it('keeps the selected phone and its actual source together', () => {
    const [merged] = deduplicateLeads([
      lead({ mobile: 'invalid', confidence: 99, contactEvidence: [], contactSourceUrl: 'https://unrelated.example' }),
      lead({ confidence: 40, contactEvidence: [observation()] }),
    ]);
    expect(merged?.mobile).toBe('5125550101');
    expect(merged?.contactSourceUrl).toBe('https://alpha-dental.com/contact');
    expect(isPhoneQualifiedLead(merged!)).toBe(true);
  });
});

describe('website contact provenance', () => {
  it('records the exact page for each phone/email and recovers from an invalid existing number', async () => {
    vi.spyOn(httpClient, 'get').mockImplementation(async (url) => ({ status: 200, headers: { 'content-type': 'text/html' }, data: String(url).includes('/contact')
      ? '<a href="tel:+15125550101">Call</a><a href="mailto:office@alpha-dental.com">Email</a>'
      : '<a href="/contact">Contact</a>' }));
    const result = await enrichLeadFromWebsite(lead({ mobile: 'invalid', contactEvidence: [], listingUrl: undefined }));
    const enriched = enrichLead(result.lead);
    expect(isPhoneQualifiedLead(enriched)).toBe(true);
    expect(getContactEvidence(enriched, 'phone')[0]?.sourceUrl).toBe('https://alpha-dental.com/contact');
    expect(getContactEvidence(enriched, 'email')[0]?.sourceUrl).toBe('https://alpha-dental.com/contact');
    expect(enriched.quality?.email.mailbox).toBe('not_checked');
  });

  it('does not follow an unrelated-domain redirect and claim its contacts', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue({ status: 302, headers: { location: 'https://unrelated.example/contact' }, data: '' });
    const result = await enrichLeadFromWebsite(lead({ mobile: '', contactEvidence: [], listingUrl: undefined }));
    expect(get).toHaveBeenCalledTimes(2);
    expect(getContactEvidence(result.lead, 'phone')).toEqual([]);
  });
});
