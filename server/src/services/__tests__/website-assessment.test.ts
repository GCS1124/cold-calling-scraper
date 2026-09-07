import { describe, expect, it } from 'vitest';

import type { Lead } from '../../types/lead';
import {
  assessWebsiteDocument,
  canUseWebsiteContactEvidence,
  parseRobotsTxt,
  preferWebsiteAssessment,
} from '../website-assessment';

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'website-test',
  name: 'Austin Dental Spa',
  headline: 'Owner at Austin Dental Spa',
  mobile: '+15125550199',
  email: '',
  website: 'https://austindental.example',
  address: '100 Congress Ave, Austin, TX 78701',
  category: 'Dentist',
  city: 'Austin',
  stateCode: 'TX',
  postalCode: '78701',
  source: 'LinkedIn',
  confidence: 80,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: false,
  scrapedAt: new Date().toISOString(),
  ...overrides,
});

describe('parseRobotsTxt', () => {
  it('applies the longest matching rule and lets a specific Allow win', () => {
    const policy = parseRobotsTxt(`
      User-agent: *
      Disallow: /private
      Allow: /private/contact
      Disallow: /tmp*
    `);

    expect(policy.status).toBe('allowed');
    expect(policy.isAllowed('https://example.com/')).toBe(true);
    expect(policy.isAllowed('https://example.com/private')).toBe(false);
    expect(policy.isAllowed('https://example.com/private/contact')).toBe(true);
    expect(policy.isAllowed('https://example.com/tmp-file')).toBe(false);
  });

  it('uses the matching crawler group instead of unrelated groups', () => {
    const policy = parseRobotsTxt(`
      User-agent: OtherBot
      Disallow: /

      User-agent: *
      Disallow: /admin
    `, 'LeadFinderPro');

    expect(policy.isAllowed('https://example.com/')).toBe(true);
    expect(policy.isAllowed('https://example.com/admin')).toBe(false);
  });
});

describe('assessWebsiteDocument', () => {
  it('confirms a business document with structured identity and matching contact data', () => {
    const assessment = assessWebsiteDocument({
      lead: makeLead(),
      sourceUrl: 'https://www.austindental.example/contact',
      html: `
        <html>
          <head><title>Austin Dental Spa | Dentist in Austin</title></head>
          <body>
            <h1>Austin Dental Spa</h1>
            <address>100 Congress Ave, Austin, TX 78701</address>
            <a href="tel:+15125550199">(512) 555-0199</a>
            <script type="application/ld+json">
              {"@type":"Dentist","name":"Austin Dental Spa","telephone":"+15125550199","address":{"addressLocality":"Austin","addressRegion":"TX","postalCode":"78701"}}
            </script>
          </body>
        </html>
      `,
      robots: 'allowed',
      phoneValues: ['+1 512 555 0199'],
      emailValues: ['hello@austindental.example'],
      addressValues: ['100 Congress Ave, Austin, TX 78701'],
    });

    expect(assessment.status).toBe('confirmed');
    expect(assessment.score).toBeGreaterThanOrEqual(55);
    expect(assessment.canonicalHost).toBe('austindental.example');
    expect(assessment.resolvedHost).toBeUndefined();
    expect(assessment.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(canUseWebsiteContactEvidence(assessment)).toBe(true);
  });

  it('keeps parked and challenge pages out of contact evidence', () => {
    const parked = assessWebsiteDocument({
      lead: makeLead(),
      sourceUrl: 'https://austindental.example',
      html: '<html><head><title>This domain is for sale</title></head><body>Buy this domain today. Call 512-555-0199.</body></html>',
      robots: 'allowed',
      phoneValues: ['+1 512 555 0199'],
    });
    const blocked = assessWebsiteDocument({
      lead: makeLead(),
      sourceUrl: 'https://austindental.example',
      html: '<html><body>Verify you are human before continuing.</body></html>',
      robots: 'allowed',
    });

    expect(parked.status).toBe('parked');
    expect(blocked.status).toBe('blocked');
    expect(canUseWebsiteContactEvidence(parked)).toBe(false);
    expect(canUseWebsiteContactEvidence(blocked)).toBe(false);
  });

  it('keeps a weak but contact-bearing page usable while exposing identity gaps', () => {
    const assessment = assessWebsiteDocument({
      lead: makeLead({ name: 'Jordan Lee', mobile: '' }),
      sourceUrl: 'https://public.example/contact',
      html: '<html><body><a href="tel:+15125550199">Call our office</a></body></html>',
      robots: 'unknown',
      phoneValues: ['+1 512 555 0199'],
    });

    expect(assessment.status).toBe('probable');
    expect(assessment.gaps).toEqual(expect.arrayContaining([
      'No public business schema markup was found.',
      'robots.txt could not be verified for this domain.',
    ]));
    expect(canUseWebsiteContactEvidence(assessment)).toBe(true);
  });

  it('prefers the strongest document assessment without hiding a weaker current result', () => {
    const weak = assessWebsiteDocument({
      lead: makeLead(),
      sourceUrl: 'https://austindental.example/contact',
      html: '<html><body>Call 512-555-0199</body></html>',
      phoneValues: ['+1 512 555 0199'],
    });
    const strong = assessWebsiteDocument({
      lead: makeLead(),
      sourceUrl: 'https://austindental.example/about',
      html: '<title>Austin Dental Spa</title><h1>Austin Dental Spa</h1><p>Dentist in Austin, TX</p>',
      robots: 'allowed',
    });

    expect(preferWebsiteAssessment(weak, strong)).toBe(strong);
    expect(preferWebsiteAssessment(strong, weak)).toBe(strong);
  });
});
