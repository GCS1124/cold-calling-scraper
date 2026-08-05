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

const makeResponse = (body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('discoverUsLeadsFromLinkedinSearch', () => {
  it('extracts public LinkedIn profiles and ignores company or jobs results', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('lite.duckduckgo.com')) {
        return makeResponse(`Title: linkedin dentist austin at DuckDuckGo

URL Source: http://lite.duckduckgo.com/lite/?q=linkedin%20dentist%20austin

Markdown Content:
1.[Mark Sweeney - Owner at Austin Dental Spa | LinkedIn](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fmark-sweeney-austin&rut=abc)
Owner at Austin Dental Spa.
2.[Austin Dentistry | LinkedIn](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Faustin-dentistry&rut=def)
Company page.
`);
      }

      if (url.includes('bing.com')) {
        return makeResponse(`Title: linkedin dentist austin - Bing

Markdown Content:
1. [Tejas Patel, DDS - Cosmetic Dentist | LinkedIn](https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly93d3cubGlua2VkaW4uY29tL2luL3RlamFzLXBhdGVsLWRkcy1hdXN0aW4&ntb=1)
Cosmetic dentist in Austin.
2. [1,000+ Dentist jobs in Austin - LinkedIn](https://www.bing.com/ck/a?!&&p=def&u=a1aHR0cHM6Ly93d3cubGlua2VkaW4uY29tL2pvYnMvZGVudGlzdC1qb2JzLWF1c3Rpbi10eCZudGI9MQ&ntb=1)
Jobs page.
`);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const leads = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Dentist',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(leads).toHaveLength(2);
    expect(new Set(leads.map((lead) => lead.id)).size).toBe(leads.length);
    expect(leads[0]?.source).toBe('LinkedIn');
    expect(leads[0]?.listingUrl).toContain('/in/');
    expect(leads.every((lead) => lead.listingUrl?.includes('/in/'))).toBe(true);
    expect(leads.some((lead) => lead.listingUrl?.includes('/company/'))).toBe(false);
    expect(leads.some((lead) => lead.listingUrl?.includes('/jobs/'))).toBe(false);
    expect(leads[0]?.name).toContain('Mark Sweeney');
  });

  it('returns an empty array when no public LinkedIn profiles are available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse(`Title: linkedin founder austin at DuckDuckGo

URL Source: http://lite.duckduckgo.com/lite/?q=linkedin%20founder%20austin

Markdown Content:
1.[Austin Dentistry | LinkedIn](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Faustin-dentistry&rut=abc)
Company page only.
`),
      ) as typeof fetch,
    );

    const leads = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Founder',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(leads).toHaveLength(0);
  });
});
