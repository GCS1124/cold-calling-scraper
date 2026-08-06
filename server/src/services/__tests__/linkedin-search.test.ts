import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverUsLeadsFromLinkedinSearch } from '../linkedin-search';

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

const makeResponse = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });

const linkedInProfileBody = `Title: LinkedIn search results

Markdown Content:
1. [Jordan Lee - Founder at Sun Trail Goods | LinkedIn](https://www.linkedin.com/in/jordan-lee-sun-trail/)
Founder at Sun Trail Goods in Austin, Texas.
`;

const makeQueryCaptureFetch = (body: string) => {
  const queries = new Set<string>();

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const parsed = new URL(url);
    const query = parsed.searchParams.get('q');

    if (query) {
      queries.add(query);
    }

    if (url.includes('search.brave.com') || url.includes('bing.com')) {
      return makeResponse(body);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  return { fetchMock, queries };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('discoverUsLeadsFromLinkedinSearch', () => {
  it('extracts public LinkedIn profiles from Brave results and canonicalizes regional subdomains', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('search.brave.com')) {
        return makeResponse(`Title: linkedin founder austin - Brave Search

URL Source: http://search.brave.com/search?q=linkedin%20founder%20Austin%20TX

Markdown Content:
[![Image 5: 🌐](https://imgs.search.brave.com/example/linkedin.png) ![Image 6: 🌐](https://imgs.search.brave.com/example/linkedin.png) LinkedIn linkedin.com › in › mark-sweeney-austin Mark Sweeney - Owner at Austin Dental Spa | Professional Profile | LinkedIn](https://www.linkedin.com/in/mark-sweeney-austin/)
5 days ago - Owner at Austin Dental Spa in Austin, Texas.
`);
      }

      if (url.includes('bing.com')) {
        return makeResponse(`Title: linkedin founder austin - Bing

Markdown Content:
1. [Mark Sweeney - Owner at Austin Dental Spa | LinkedIn](https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9uZy5saW5rZWRpbi5jb20vaW4vbWFyay1zd2VlbmV5LWF1c3Rpbi8&ntb=1)
Owner at Austin Dental Spa.
`);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Dentist',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.blocked).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.source).toBe('LinkedIn');
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/in/mark-sweeney-austin');
    expect(new Set(result.leads.map((lead) => lead.id)).size).toBe(result.leads.length);
    expect(result.leads[0]?.name).toContain('Mark Sweeney');
    expect(result.leads[0]?.listingUrl).toContain('/in/');
  });

  it('returns warnings when the public search pages are blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com')) {
          return makeResponse(`Title: Brave Search

Markdown Content:
Verify you are not a bot before continuing.
`, 200);
        }

        if (url.includes('bing.com')) {
          return makeResponse(`Title: Bing Search

Markdown Content:
Too many requests. Please try again later.
`, 200);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Founder',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(0);
    expect(result.blocked).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.providerName === 'Brave Search')).toBe(true);
    expect(result.warnings.some((warning) => warning.providerName === 'Bing')).toBe(true);
  });

  it('returns a clear no-results warning when no public LinkedIn profiles are available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com')) {
          return makeResponse(`Title: linkedin founder austin search results

Markdown Content:
1. Some unrelated business result
2. Another unrelated result
`);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Founder',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(0);
    expect(result.blocked).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain('No public LinkedIn profiles');
  });

  it('expands ecommerce brand searches across store and D2C synonyms', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(linkedInProfileBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Ecommerce brand',
        city: 'Austin',
        count: 350,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.blocked).toBe(false);
    expect(result.leads).toHaveLength(1);

    const queryList = [...queries];
    expect(queryList.length).toBeGreaterThanOrEqual(9);
    expect(queryList.some((query) => query.includes('shopify store'))).toBe(true);
    expect(queryList.some((query) => query.includes('direct-to-consumer brand'))).toBe(true);
    expect(queryList.some((query) => /brand founder|owner/i.test(query))).toBe(true);
  });

  it('expands HVAC searches with service and field manager roles', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(linkedInProfileBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'HVAC contractor',
        city: 'Austin',
        count: 350,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.blocked).toBe(false);
    expect(result.leads).toHaveLength(1);

    const queryList = [...queries];
    expect(queryList.length).toBeGreaterThanOrEqual(9);
    expect(queryList.some((query) => query.includes('hvac contractor'))).toBe(true);
    expect(
      queryList.some((query) => /service manager|field manager|franchise owner/i.test(query)),
    ).toBe(true);
  });
});
