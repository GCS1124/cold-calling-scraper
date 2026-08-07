import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';
import { httpClient } from '../../utils/http-client';
import { enrichLinkedinLeadsWithPublicContacts } from '../linkedin-contact-enrichment';

vi.mock('../../utils/http-client', () => ({
  httpClient: {
    get: vi.fn(),
  },
}));

const sampleLocation = {
  mode: 'local' as const,
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

const makeLead = (): Lead => ({
  id: 'linkedin-jordan-lee',
  name: 'Jordan Lee',
  headline: 'Owner at Austin Dental Spa',
  mobile: '',
  email: '',
  website: '',
  address: '',
  category: 'Dentist',
  city: 'Austin, TX',
  source: 'LinkedIn',
  confidence: 90,
  sourceScore: 86,
  listingUrl: 'https://linkedin.com/in/jordan-lee',
  hasEmail: false,
  hasPhone: false,
  hasWebsite: false,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: new Date().toISOString(),
});

const publicWebsiteSearchBody = `Title: public website results

Markdown Content:
1. [Austin Dental Spa](https://austindentalspa.example/contact)
Austin Dental Spa provides dental care in Austin, TX. Call (512) 555-0199 or email hello@austindentalspa.example.
`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enrichLinkedinLeadsWithPublicContacts', () => {
  it('resolves a public business website and extracts validated contact details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return new Response(publicWebsiteSearchBody, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    vi.mocked(httpClient.get).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: `
        <html>
          <body>
            <a href="mailto:hello@austindentalspa.example">Email</a>
            <a href="tel:+15125550199">Call</a>
          </body>
        </html>
      `,
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: {
        companyType: 'Dentist',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    const lead = result.leads[0];

    expect(result.warnings).toHaveLength(0);
    expect(result.enrichedCount).toBe(1);
    expect(lead?.website).toBe('https://austindentalspa.example/contact');
    expect(lead?.email).toBe('hello@austindentalspa.example');
    expect(lead?.mobile).toBe('+1 512 555 0199');
    expect(lead?.hasEmail).toBe(true);
    expect(lead?.hasPhone).toBe(true);
    expect(lead?.hasWebsite).toBe(true);
    expect(lead?.verifiedEmail).toBe(true);
    expect(lead?.verifiedPhone).toBe(true);
    expect(lead?.source).toContain('LinkedIn');
    expect(lead?.source).toContain('Public Web');
    expect(lead?.source).toContain('Website Crawl');
    expect(lead?.listingUrl).toBe('https://linkedin.com/in/jordan-lee');

    const searchUrls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(searchUrls.every((url) => url.includes('-site%3Alinkedin.com') || url.includes('-site:linkedin.com'))).toBe(true);
  });

  it('keeps contact fields empty and returns warnings when public search is blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('Verify you are not a bot before continuing.', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ) as typeof fetch,
    );

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: {
        companyType: 'Dentist',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.enrichedCount).toBe(1);
    expect(result.leads[0]?.email).toBe('');
    expect(result.leads[0]?.mobile).toBe('');
    expect(result.leads[0]?.website).toBe('');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does not treat directory and portal URLs as business websites', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return new Response(
            `Title: directory results\n\nMarkdown Content:\n1. [Directory listing](https://local.yahoo.com/info/dentist)\n2. [Business site](https://austindentalspa.example/contact)\n`,
            { status: 200, headers: { 'Content-Type': 'text/plain' } },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    vi.mocked(httpClient.get).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: '<a href="tel:+15125550199">Call</a>',
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/contact');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0199');
  });
});
