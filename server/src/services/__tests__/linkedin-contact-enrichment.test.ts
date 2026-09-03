import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';
import { httpClient } from '../../utils/http-client';
import {
  enrichLinkedinLeadsWithPublicContacts,
} from '../linkedin-contact-enrichment';
import { enrichLeadFromWebsite } from '../website-enrichment';

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

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
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
  ...overrides,
});

const publicWebsiteSearchBody = `Title: public website results

Markdown Content:
1. [Austin Dental Spa](https://austindentalspa.example/contact)
Austin Dental Spa provides dental care in Austin, TX. Call (512) 555-0199 or email hello@austindentalspa.example.
`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(httpClient.get).mockReset();
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
            <a href="https://facebook.com/austin-dental-spa">Facebook</a>
            <a href="https://www.youtube.com/@austin-dental-spa">YouTube</a>
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
    expect(lead?.contactSourceUrl).toBe('https://austindentalspa.example/contact');
    expect(lead?.publicSocialLinks).toEqual(
      expect.arrayContaining([
        { platform: 'Facebook', url: 'https://facebook.com/austin-dental-spa' },
        { platform: 'YouTube', url: 'https://www.youtube.com/@austin-dental-spa' },
      ]),
    );
    expect(lead?.source).toContain('LinkedIn');
    expect(lead?.source).toContain('Public Web');
    expect(lead?.source).toContain('Website Crawl');
    expect(lead?.listingUrl).toBe('https://linkedin.com/in/jordan-lee');

    const searchUrls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(searchUrls.every((url) => url.includes('-site%3Alinkedin.com') || url.includes('-site:linkedin.com'))).toBe(true);
  });

  it('resolves bare public domains from contact-search results', async () => {
    const domainOnlySearchBody = `Title: public website results

Markdown Content:
1. Austin Dental Spa | austindentalspa.example
Austin Dental Spa provides dental care in Austin, TX. Call (512) 555-0199 or email hello@austindentalspa.example.
`;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return new Response(domainOnlySearchBody, {
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
      data: '<a href="mailto:hello@austindentalspa.example">Email</a>',
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads[0]?.website).toBe('https://austindentalspa.example');
    expect(result.leads[0]?.email).toBe('hello@austindentalspa.example');
    expect(result.leads[0]?.hasWebsite).toBe(true);
  });

  it('parses native Bing HTML without treating embedded challenge scripts as a block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('www.bing.com')) {
          return new Response(`<!doctype html><html><body>
<script>const challenge = "PowChallengeSolver";</script>
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9hdXN0aW5kZW50YWxzcGEuZXhhbXBsZS9jb250YWN0&ntb=1">Austin Dental Spa &ndash; official website &#99999999;</a></h2>
  <div class="b_caption">Austin Dental Spa is a dentist in Austin, TX. Call (512) 555-0199 or email hello@austindentalspa.example.</div>
</li>
</body></html>`, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }

        if (url.includes('search.brave.com') || url.includes('html.duckduckgo.com')) {
          return new Response('Title: no results', {
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
      data: '<a href="mailto:hello@austindentalspa.example">Email</a><a href="tel:+15125550199">Call</a>',
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/contact');
    expect(result.leads[0]?.email).toBe('hello@austindentalspa.example');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0199');
  });

  it('keeps public snippet contacts when the matched business website cannot be crawled', async () => {
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

    vi.mocked(httpClient.get).mockRejectedValue(new Error('Website blocked'));

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/contact');
    expect(result.leads[0]?.email).toBe('hello@austindentalspa.example');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0199');
    expect(result.leads[0]?.source).toContain('Public Web');
    expect(result.leads[0]?.rejectionReason).not.toBe('blocked_website');
  });

  it('tries the next ranked public business site when the best match is unavailable', async () => {
    const multiSiteSearchBody = `Title: public website results

Markdown Content:
1. [Austin Dental Spa](https://austindentalspa.example/contact)
Jordan Lee is the owner of Austin Dental Spa, a dentist in Austin, TX.
2. [Stone Dental](https://stonedental.example/contact)
Jordan Lee is the owner of Stone Dental, a dentist in Austin, TX. Call (512) 555-0144 or email hello@stonedental.example.
`;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return new Response(multiSiteSearchBody, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    vi.mocked(httpClient.get).mockClear();
    vi.mocked(httpClient.get).mockImplementation(async (url) => {
      if (String(url).includes('austindentalspa.example')) {
        throw new Error('Best-match website unavailable');
      }

      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<a href="mailto:hello@stonedental.example">Email</a><a href="tel:+15125550144">Call</a>',
      } as never;
    });

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads[0]?.website).toBe('https://stonedental.example/contact');
    expect(result.leads[0]?.email).toBe('hello@stonedental.example');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0144');
    expect(result.leads[0]?.source).toContain('Website Crawl');
    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });

  it('falls back to DuckDuckGo when the first free contact providers are blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return new Response('Verify you are not a bot. Too many requests.', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

        if (url.includes('html.duckduckgo.com')) {
          return new Response(
            `<!doctype html><html><body>
              <div class="result">
                <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Faustindentalspa.example%2Fcontact" class="result__a">Austin Dental Spa official website</a>
                <a class="result__snippet">Austin Dental Spa in Austin, TX. Call (512) 555-0199 or email hello@austindentalspa.example.</a>
              </div>
            </body></html>`,
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    vi.mocked(httpClient.get).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: `
        <a href="mailto:hello@austindentalspa.example">Email</a>
        <a href="tel:+15125550199">Call</a>
      `,
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/contact');
    expect(result.leads[0]?.email).toBe('hello@austindentalspa.example');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0199');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.providerName === 'Brave Search')).toBe(true);
    expect(result.warnings.some((warning) => warning.providerName === 'Bing')).toBe(true);
  });

  it('uses Yahoo as a final public contact-search fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (
          url.includes('search.brave.com') ||
          url.includes('www.bing.com') ||
          url.includes('html.duckduckgo.com')
        ) {
          return new Response('Verify you are not a bot. Too many requests.', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

        if (url.includes('search.yahoo.com')) {
          return new Response(
            `<!doctype html><html><body>
              <div class="algo-sr">
                <a href="https://search.yahoo.com/r/RU=https%3A%2F%2Faustindentalspa.example%2Fcontact/RK=2">Austin Dental Spa official website</a>
                <p class="compText aAbs">Austin Dental Spa in Austin, TX. Call (512) 555-0199 or email hello@austindentalspa.example.</p>
              </div>
            </body></html>`,
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    vi.mocked(httpClient.get).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: '<a href="mailto:hello@austindentalspa.example">Email</a><a href="tel:+15125550199">Call</a>',
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/contact');
    expect(result.leads[0]?.email).toBe('hello@austindentalspa.example');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0199');
    expect(result.warnings.map((warning) => warning.providerName)).toEqual(
      expect.arrayContaining(['Brave Search', 'Bing', 'DuckDuckGo']),
    );
  });

  it('uses a simple LinkedIn headline as organization context for enrichment', async () => {
    const publicOrganizationSearchBody = `Title: public website results

Markdown Content:
1. [AVMSmiles](https://avmsmiles.example/contact)
AVMSmiles is a dentist in Austin, TX. Call (512) 555-0199 or email hello@avmsmiles.example.
`;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return new Response(publicOrganizationSearchBody, {
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
      data: '<a href="mailto:hello@avmsmiles.example">Email</a>',
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead({ headline: 'AVMSmiles' })],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    const searchUrls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));

    expect(searchUrls.some((url) => /AVMSmiles/i.test(decodeURIComponent(url)))).toBe(true);
    expect(result.leads[0]?.website).toBe('https://avmsmiles.example/contact');
    expect(result.leads[0]?.email).toBe('hello@avmsmiles.example');
  });

  it('uses concrete metro seeds instead of a timezone label for contact lookup', async () => {
    const queries: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const decodedUrl = decodeURIComponent(url);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          queries.push(decodedUrl);

          return new Response(
            decodedUrl.includes('New York, NY') ? publicWebsiteSearchBody : 'Title: no results',
            { status: 200, headers: { 'Content-Type': 'text/plain' } },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    vi.mocked(httpClient.get).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: '<a href="mailto:hello@austindentalspa.example">Email</a>',
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead({ headline: 'Owner at Austin Dental Spa' })],
      request: { companyType: 'Dentist', city: 'Eastern Time', count: 1 },
      location: {
        ...sampleLocation,
        mode: 'timezone',
        label: 'Eastern Time',
        city: 'Eastern Time',
        stateCode: '',
        timeZoneCode: 'ET',
      },
      deadlineMs: Date.now() + 10_000,
    });

    expect(queries.some((query) => query.includes('New York, NY'))).toBe(true);
    expect(queries.every((query) => !query.includes('Eastern Time'))).toBe(true);
    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/contact');
  });

  it('uses a public profile city in contact lookup for timezone leads', async () => {
    const queries: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const decodedUrl = decodeURIComponent(url);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          queries.push(decodedUrl);
          return new Response(
            decodedUrl.includes('Miami, FL') ? publicWebsiteSearchBody : 'Title: no results',
            { status: 200, headers: { 'Content-Type': 'text/plain' } },
          );
        }

        throw new Error('Unexpected fetch: ' + url);
      }) as typeof fetch,
    );

    vi.mocked(httpClient.get).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: '<a href="tel:+15125550199">Call</a>',
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead({ city: 'Miami', stateCode: 'FL' })],
      request: { companyType: 'Dentist', city: 'Eastern Time', count: 1 },
      location: {
        ...sampleLocation,
        mode: 'timezone',
        label: 'Eastern Time',
        city: 'Eastern Time',
        stateCode: '',
        timeZoneCode: 'ET',
      },
      deadlineMs: Date.now() + 10_000,
    });

    expect(queries.some((query) => query.includes('Miami, FL'))).toBe(true);
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0199');
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

  it('aborts hanging public contact providers at the enrichment deadline', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (!signal) {
            reject(new Error('Missing abort signal'));
            return;
          }

          signal.addEventListener(
            'abort',
            () => reject(new Error('Contact deadline exceeded')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);
    vi.mocked(httpClient.get).mockClear();

    const startedAt = Date.now();
    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: startedAt + 40,
    });

    expect(result.enrichedCount).toBe(1);
    expect(result.leads[0]?.email).toBe('');
    expect(result.leads[0]?.mobile).toBe('');
    expect(fetchMock).toHaveBeenCalled();
    expect(httpClient.get).not.toHaveBeenCalled();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('preserves one malformed lead without dropping the rest of the enrichment batch', async () => {
    const malformedLead = makeLead({
      id: 'linkedin-malformed',
      source: { invalid: true } as never,
    });
    const validLead = makeLead({
      id: 'linkedin-valid',
      website: 'https://austindentalspa.example',
    });

    vi.mocked(httpClient.get).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: '<a href="mailto:hello@austindentalspa.example">Email</a>',
    } as never);

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [malformedLead, validLead],
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.enrichedCount).toBe(2);
    expect(result.leads[0]).toBe(malformedLead);
    expect(result.leads[1]?.email).toBe('hello@austindentalspa.example');
    expect(
      result.warnings.some((warning) =>
        warning.message.includes('original fields were preserved'),
      ),
    ).toBe(true);
  });

  it('counts deadline-skipped leads as preserved work', async () => {
    const progress: number[] = [];

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead(), makeLead({ id: 'linkedin-second' })],
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() - 1,
      onProgress: (completed) => progress.push(completed),
    });

    expect(result.enrichedCount).toBe(2);
    expect(progress).toEqual([1, 2]);
    expect(result.leads).toHaveLength(2);
    expect(result.leads.every((lead) => lead.name)).toBe(true);
  });

  it('does not treat directory and portal URLs as business websites', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return new Response(
            `Title: directory results\n\nMarkdown Content:\n1. [Directory listing](https://local.yahoo.com/info/dentist)\n2. [Encyclopedia](https://en.m.wikipedia.org/wiki/Dentistry)\n3. [Business site](https://austindentalspa.example/contact)\n`,
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

  it('does not attach a generic city website without person or organization evidence', async () => {
    vi.mocked(httpClient.get).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          `Title: city results\n\nMarkdown Content:\n1. [Visit Austin](https://austintexas.org/)\nOfficial visitor information and things to do in Austin, Texas.\n`,
          { status: 200, headers: { 'Content-Type': 'text/plain' } },
        ),
      ) as typeof fetch,
    );

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [makeLead()],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads[0]?.website).toBe('');
    expect(result.leads[0]?.email).toBe('');
    expect(result.leads[0]?.mobile).toBe('');
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it('ignores headline attribution suffixes when matching a business website', async () => {
    const attributionSearchBody = `Title: public website results

Markdown Content:
1. [Board directory](https://board.example)
Board member directory and professional resources in Austin, TX.
2. [Restimulate Health](https://restimulate.example)
Restimulate Health is a dental practice in Austin, TX. Call (512) 555-0188.
`;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return new Response(attributionSearchBody, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    vi.mocked(httpClient.get).mockImplementation(async (url) => {
      if (String(url).includes('board.example')) {
        throw new Error('Unrelated website must not be crawled');
      }

      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<a href="tel:+15125550188">Call</a>',
      } as never;
    });

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [
        makeLead({
          name: 'Dr. Edward Alvarez',
          headline: 'Founder & CEO, Restimulate Health | Board Member at Board',
        }),
      ],
      request: { companyType: 'Dentist', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads[0]?.website).toBe('https://restimulate.example');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0188');
    expect(httpClient.get).toHaveBeenCalledWith(
      'https://restimulate.example/',
      expect.anything(),
    );
    expect(
      vi.mocked(httpClient.get).mock.calls.some(([url]) => String(url).includes('board.example')),
    ).toBe(false);
  });

  it('does not crawl loopback or private-network websites from public lead data', async () => {
    const unsafeWebsites = [
      'http://127.0.0.1/admin',
      'http://localhost/contact',
      'http://192.168.1.10/contact',
      'http://[::1]/contact',
    ];

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: unsafeWebsites.map((website, index) =>
        makeLead({ id: `unsafe-${index}`, website, hasWebsite: true }),
      ),
      request: { companyType: 'Dentist', city: 'Austin', count: unsafeWebsites.length },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    expect(result.leads.map((lead) => lead.website)).toEqual(unsafeWebsites);
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it('revalidates redirect destinations before following them', async () => {
    vi.mocked(httpClient.get).mockResolvedValue({
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
      data: '',
    } as never);

    const result = await enrichLeadFromWebsite(makeLead({ website: 'https://public.example' }));

    expect(result.lead.website).toBe('https://public.example/');
    expect(result.lead.crawlAttempts).toBe(1);
    expect(httpClient.get).toHaveBeenCalledWith(
      'https://public.example/',
      expect.objectContaining({ maxRedirects: 0 }),
    );
    expect(httpClient.get).toHaveBeenCalledTimes(1);
  });

  it('continues to the next public query after a low-confidence website result', async () => {
    let searchCallCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          searchCallCount += 1;
          return new Response(
            searchCallCount <= 2
              ? `Title: city results\n\nMarkdown Content:\n1. [Visit Austin](https://austintexas.org/)\nOfficial visitor information and things to do in Austin, Texas.\n`
              : publicWebsiteSearchBody,
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

    expect(searchCallCount).toBeGreaterThan(2);
    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/contact');
    expect(result.leads[0]?.mobile).toBe('+1 512 555 0199');
  });

  it('keeps role-only headlines category-aware when resolving a public website', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('Title: no public website results', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ) as typeof fetch,
    );

    const result = await enrichLinkedinLeadsWithPublicContacts({
      leads: [
        makeLead({
          name: 'Casey Rao',
          headline: 'Engineering Manager',
          category: 'Cybersecurity company',
        }),
      ],
      request: { companyType: 'Cybersecurity company', city: 'Austin', count: 1 },
      location: sampleLocation,
      deadlineMs: Date.now() + 10_000,
    });

    const decodedSearchUrls = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => decodeURIComponent(String(input)));

    expect(result.leads[0]?.website).toBe('');
    expect(
      decodedSearchUrls.some((url) =>
        url.includes('"Casey Rao" "Cybersecurity company"'),
      ),
    ).toBe(true);
    expect(
      decodedSearchUrls.some((url) =>
        url.includes('"Engineering Manager" "Austin, TX" official website'),
      ),
    ).toBe(false);
  });
});
