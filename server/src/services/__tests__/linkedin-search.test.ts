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

const ecommerceProfileBody = `Title: LinkedIn search results

Markdown Content:
1. [Jordan Lee - Founder at Sun Trail Goods | LinkedIn](https://www.linkedin.com/in/jordan-lee-sun-trail/)
Founder of a direct-to-consumer ecommerce brand in Austin, Texas.
`;

const hvacProfileBody = `Title: LinkedIn search results

Markdown Content:
1. [Alex Morgan - Owner at Apex Heating and Cooling | LinkedIn](https://www.linkedin.com/in/alex-morgan-hvac/)
Owner of an HVAC contractor serving Austin, Texas.
`;

const dentalProfileBody = `Title: LinkedIn search results

Markdown Content:
1. [Mark Sweeney - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/mark-sweeney-austin/)
Dentist and practice owner at Austin Dental Spa in Austin, Texas.
`;

const emptyDuckDuckGoBody = '<!doctype html><html><body>No results.</body></html>';

type QueryRoute = {
  match: (query: string) => boolean;
  body: string;
  status?: number;
};

const makeQueryCaptureFetch = (body: string, routes: QueryRoute[] = []) => {
  const queries = new Set<string>();

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const parsed = new URL(url);
    const query = parsed.searchParams.get('q') ?? parsed.searchParams.get('p');

    if (query) {
      queries.add(query);
    }

    if (
      url.includes('search.brave.com') ||
      url.includes('bing.com') ||
      url.includes('html.duckduckgo.com') ||
      url.includes('search.yahoo.com')
    ) {
      const routedBody = routes.find((route) => query && route.match(query));
      if (routedBody) {
        return makeResponse(routedBody.body, routedBody.status ?? 200);
      }

      if (url.includes('html.duckduckgo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
      }

      if (url.includes('search.yahoo.com')) {
        return makeResponse(body);
      }

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

      if (url.includes('html.duckduckgo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
      }

      if (url.includes('search.yahoo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
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
    expect(result.leads[0]?.source).toBe('LinkedIn, Public Profile');
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/in/mark-sweeney-austin');
    expect(new Set(result.leads.map((lead) => lead.id)).size).toBe(result.leads.length);
    expect(result.leads[0]?.name).toContain('Mark Sweeney');
    expect(result.leads[0]?.listingUrl).toContain('/in/');
    expect(result.leads[0]?.publicEvidence).toMatchObject({
      profileTitle: expect.stringContaining('Mark Sweeney'),
      profileSnippet: expect.stringContaining('Owner at Austin Dental Spa'),
      sources: expect.arrayContaining([
        expect.objectContaining({
          providerName: 'Brave Search',
          profileTitle: expect.stringContaining('Mark Sweeney'),
        }),
        expect.objectContaining({
          providerName: 'Bing',
          profileSnippet: expect.stringContaining('Owner at Austin Dental Spa'),
        }),
      ]),
    });
    expect(result.leads[0]?.matchSignals).toMatchObject({
      queryMatches: expect.any(Number),
      publicSources: expect.any(Number),
      publicProviderNames: expect.arrayContaining(['Brave Search', 'Bing']),
      categoryMatched: true,
      roleMatched: true,
      locationMatched: true,
    });
    expect(result.coverage?.queriesAttempted).toBeGreaterThan(0);
    expect(result.coverage?.providersChecked).toBe(4);
  });

  it('extracts multiple public profiles from compact search-result lines', async () => {
    const compactBody = `Title: LinkedIn search results

Markdown Content:
1. [Alicia Stone - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/alicia-stone-austin/) [Jordan Carter - Operations Manager at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/jordan-carter-austin/)
Both are public decision-makers at an Austin dental practice in Austin, Texas.
`;
    const { fetchMock } = makeQueryCaptureFetch(compactBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(2);
    expect(result.leads.map((lead) => lead.name)).toEqual([
      'Alicia Stone',
      'Jordan Carter',
    ]);
    expect(result.leads.map((lead) => lead.listingUrl)).toEqual([
      'https://linkedin.com/in/alicia-stone-austin',
      'https://linkedin.com/in/jordan-carter-austin',
    ]);
  });

  it('bounds public LinkedIn evidence before returning a lead', async () => {
    const longTitle = 'Sam Carter - Dentist and practice owner at Austin Dental Clinic - ' +
      'Public clinic leader '.repeat(20) +
      ' | LinkedIn';
    const longSnippet = 'Dentist and public clinic owner serving Austin, Texas. '.repeat(20);
    const longBody = [
      'Title: LinkedIn results',
      '',
      'Markdown Content:',
      '',
      '1. [' + longTitle + '](https://www.linkedin.com/in/sam-carter-austin/)',
      longSnippet,
    ].join('\n');
    const { fetchMock } = makeQueryCaptureFetch(longBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.publicEvidence?.profileTitle?.length).toBeLessThanOrEqual(240);
    expect(result.leads[0]?.publicEvidence?.profileSnippet?.length).toBeLessThanOrEqual(360);
    expect(result.leads[0]?.publicEvidence?.profileTitle).toMatch(/\.\.\.$/);
    expect(result.leads[0]?.publicEvidence?.profileSnippet).toMatch(/\.\.\.$/);
    expect(result.leads[0]?.publicEvidence?.sources).toHaveLength(2);
    expect(
      result.leads[0]?.publicEvidence?.sources?.every(
        (source) =>
          (source.profileTitle?.length ?? 0) <= 240 &&
          (source.profileSnippet?.length ?? 0) <= 360,
      ),
    ).toBe(true);
  });

  it('discovers legacy public LinkedIn /pub profiles', async () => {
    const queries: string[] = [];
    const legacyProfileBody = [
      'Title: LinkedIn legacy public profiles',
      '',
      'Markdown Content:',
      '',
      '1. [linkedin.com › pub › olivia-wilson Olivia Wilson - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/pub/olivia-wilson/1/12345)',
      'Owner of a dental clinic serving Austin, Texas.',
    ].join('\n');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const parsed = new URL(url);
      const query = decodeURIComponent(
        parsed.searchParams.get('q') ?? parsed.searchParams.get('p') ?? '',
      );

      if (query) {
        queries.push(query);
      }

      if (
        (url.includes('search.brave.com') || url.includes('bing.com') || url.includes('search.yahoo.com')) &&
        query.includes('site:linkedin.com/pub/')
      ) {
        return makeResponse(legacyProfileBody);
      }

      if (url.includes('html.duckduckgo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
      }

      if (url.includes('search.yahoo.com')) {
        return makeResponse('Title: no public profile matches');
      }

      return makeResponse('Title: no public profile matches');
    });

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.name).toContain('Olivia Wilson');
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/pub/olivia-wilson');
    expect(result.leads[0]?.source).toBe('LinkedIn, Public Profile');
    expect(queries.some((query) => query.includes('site:linkedin.com/pub/'))).toBe(true);
  });

  it('rotates legacy /pub role queries alongside modern /in/ queries', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(emptyDuckDuckGoBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(
      [...queries].some(
        (query) =>
          query.includes('site:linkedin.com/pub/') &&
          /practice owner|clinic owner|office manager/i.test(query),
      ),
    ).toBe(true);
    expect([...queries].some((query) => query.includes('site:linkedin.com/in/'))).toBe(true);
  });

  it('ranks profiles corroborated by multiple public providers above single-provider matches', async () => {
    const corroboratedProfile = `1. [Morgan Chen - Owner at Austin Dental Care | LinkedIn](https://www.linkedin.com/in/morgan-chen-dental/)
Dentist and practice owner in Austin, Texas.`;
    const singleProviderProfile = `2. [Taylor Reed - Owner at Reed Dental | LinkedIn](https://www.linkedin.com/in/taylor-reed-dental/)
Dentist and practice owner in Austin, Texas.`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('search.brave.com')) {
        return makeResponse(
          `Title: LinkedIn search results\n\nMarkdown Content:\n${corroboratedProfile}\n${singleProviderProfile}`,
        );
      }

      if (url.includes('bing.com')) {
        return makeResponse(
          `Title: LinkedIn search results\n\nMarkdown Content:\n${corroboratedProfile}`,
        );
      }

      if (url.includes('html.duckduckgo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
      }

      if (url.includes('search.yahoo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads.map((lead) => lead.name)).toEqual([
      'Morgan Chen',
      'Taylor Reed',
    ]);
  });

  it('parses native Bing HTML and keeps only matching public LinkedIn profiles', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('www.bing.com')) {
        return makeResponse(`<!doctype html><html><body>
<script>const challenge = "PowChallengeSolver";</script>
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9saW5rZWRpbi5jb20vaW4vbW9yZ2FuLWRpYXotZGVudGFsLw&ntb=1">Morgan Diaz &ndash; Owner at Austin Dental Spa | LinkedIn &#99999999;</a></h2>
  <div class="b_caption">Dentist and practice owner serving Austin, TX.</div>
</li>
</body></html>`);
      }

      if (url.includes('search.brave.com') || url.includes('html.duckduckgo.com') || url.includes('search.yahoo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
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
    expect(result.leads[0]?.name).toContain('Morgan Diaz');
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/in/morgan-diaz-dental');
    expect(result.leads[0]?.city).toBe('Austin');
    expect(result.leads[0]?.stateCode).toBe('TX');
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

        if (url.includes('html.duckduckgo.com')) {
          return makeResponse('<html><body>Bots use DuckDuckGo.</body></html>');
        }

        if (url.includes('search.yahoo.com')) {
          return makeResponse('Yahoo Search is temporarily unavailable.');
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
    expect(
      result.warnings.every((warning) =>
        warning.message.includes('No public-search fallback remained available.'),
      ),
    ).toBe(true);
  });

  it('parses Yahoo public-search redirects without treating Yahoo as LinkedIn data', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('search.yahoo.com')) {
        return makeResponse(`<!doctype html><html><body>
<div class="algo-sr">
  <a class="d-ib fz-20 lh-26" href="https://search.yahoo.com/r/RU=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjordan-carter-hvac%2F/RK=2">Jordan Carter - Owner at Austin Heating and Cooling | LinkedIn</a>
  <p class="compText aAbs">HVAC contractor owner serving Austin, Texas.</p>
</div>
</body></html>`);
      }

      return makeResponse(emptyDuckDuckGoBody);
    });

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'HVAC contractor', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.name).toBe('Jordan Carter');
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/in/jordan-carter-hvac');
    expect(result.leads[0]?.matchSignals?.publicProviderNames).toContain('Yahoo Search');
  });

  it('treats browser verification pages as blocked instead of valid empty results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com')) {
          return makeResponse('Just a moment... Checking your browser before accessing this site.', 200);
        }

        if (url.includes('bing.com')) {
          return makeResponse('Please enable JavaScript to continue. Robot check in progress.', 200);
        }

        if (url.includes('html.duckduckgo.com')) {
          return makeResponse('<html><body>cf-chl=challenge-platform</body></html>');
        }

        if (url.includes('search.yahoo.com')) {
          return makeResponse('Yahoo Search is temporarily unavailable.');
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    );

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Dentist',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(0);
    expect(result.blocked).toBe(true);
    expect(result.warnings.some((warning) => warning.providerName === 'Brave Search')).toBe(true);
    expect(result.warnings.some((warning) => warning.providerName === 'Bing')).toBe(true);
    expect(result.warnings.some((warning) => warning.providerName === 'DuckDuckGo')).toBe(true);
  });

  it('aborts hanging public-search providers at the discovery deadline', async () => {
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
            () => reject(new Error('Discovery deadline exceeded')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const startedAt = Date.now();
    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: startedAt + 250,
    });

    expect(result.leads).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalled();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('returns a clear no-results warning when no public LinkedIn profiles are available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('search.brave.com') || url.includes('bing.com') || url.includes('search.yahoo.com')) {
          return makeResponse(`Title: linkedin founder austin search results

Markdown Content:
1. Some unrelated business result
2. Another unrelated result
`);
        }

        if (url.includes('html.duckduckgo.com')) {
          return makeResponse(emptyDuckDuckGoBody);
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
    const { fetchMock, queries } = makeQueryCaptureFetch(ecommerceProfileBody);

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
    expect(queryList.length).toBeGreaterThanOrEqual(10);
    expect(
      queryList.some((query) =>
        query.includes('site:linkedin.com/in/ Ecommerce brand in Austin TX'),
      ),
    ).toBe(true);
    expect(queryList.some((query) => query.includes('shopify store'))).toBe(true);
    expect(queryList.some((query) => query.includes('direct-to-consumer brand'))).toBe(true);
    expect(queryList.some((query) => /brand founder|owner/i.test(query))).toBe(true);
  });

  it('keeps custom company types usable while matching category words exactly', async () => {
    const { fetchMock } = makeQueryCaptureFetch(`Title: LinkedIn search results

Markdown Content:
1. [Jordan Carter - Owner at Sunbeam Solar Systems | LinkedIn](https://www.linkedin.com/in/jordan-carter-solar/)
Owner of a solar installer serving Austin, Texas.
`);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const customCategoryResult = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Solar installer',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(customCategoryResult.leads).toHaveLength(1);
    expect(customCategoryResult.leads[0]?.name).toContain('Jordan Carter');

    const unrelatedCategoryFetch = makeQueryCaptureFetch(`Title: LinkedIn search results

Markdown Content:
1. [Jordan Carter - Party Planner | LinkedIn](https://www.linkedin.com/in/jordan-carter-party/)
Party planner serving Austin, Texas.
`);
    vi.stubGlobal('fetch', unrelatedCategoryFetch.fetchMock as typeof fetch);

    const unrelatedCategoryResult = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Art',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(unrelatedCategoryResult.leads).toHaveLength(0);
  });

  it('matches singular public evidence for custom plural company types', async () => {
    const { fetchMock } = makeQueryCaptureFetch(`Title: LinkedIn search results

Markdown Content:
1. [Taylor Nguyen - Founder at Bright AI | LinkedIn](https://www.linkedin.com/in/taylor-nguyen-ai/)
Founder of an AI startup serving Austin, Texas.
`);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'AI Startups',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.name).toContain('Taylor Nguyen');
  });

  it('mixes LinkedIn role queries with the broader discovery planner for service categories', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(hvacProfileBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'HVAC Contractors',
        city: 'Austin',
        count: 350,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.blocked).toBe(false);
    expect(result.leads).toHaveLength(1);

    const queryList = [...queries];
    expect(queryList.length).toBeGreaterThanOrEqual(10);
    expect(
      queryList.some((query) =>
        query.includes('site:linkedin.com/in/ HVAC Contractors in Austin TX'),
      ),
    ).toBe(true);
    expect(
      queryList.some((query) => /service manager|field manager|franchise owner/i.test(query)),
    ).toBe(true);
  });

  it('covers executive role variants for custom company types', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(`Title: LinkedIn search results

Markdown Content:
1. [Taylor Brooks - Chief Operating Officer at Sunbeam Solar Systems | LinkedIn](https://www.linkedin.com/in/taylor-brooks-solar/)
Chief operating officer at a solar installer serving Austin, Texas.
`);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Solar installer',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.name).toContain('Taylor Brooks');
    expect(
      [...queries].some((query) => /chief operating officer|coo|managing director|vice president/i.test(query)),
    ).toBe(true);
  });

  it('keeps category evidence in fallback searches instead of issuing broad role-only queries', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(
      `Title: linkedin founder austin search results

Markdown Content:
1. Some unrelated business result
2. Another unrelated result
`,
      [
        {
          match: (query) =>
            query.includes(
              'site:linkedin.com/in/ "practice manager" "dental clinic" "Austin TX"',
            ),
          body: dentalProfileBody,
        },
      ],
    );

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

    const queryList = [...queries];
    expect(queryList.length).toBeGreaterThan(10);
    expect(queryList.some((query) => query.includes('Dentist'))).toBe(true);
    expect(
      queryList.some((query) =>
        query.includes('site:linkedin.com/in/ "practice manager" "dental clinic" "Austin TX"'),
      ),
    ).toBe(true);
    expect(
      queryList.every(
        (query) =>
          !/practice owner|clinic owner|office manager|practice manager|founder|owner/i.test(
            query,
          ) || /dentist|dental|orthodont|periodont|oral surgeon/i.test(query),
      ),
    ).toBe(true);
  });

  it('does not repeat a normalized public query during the fallback phase', async () => {
    const { fetchMock } = makeQueryCaptureFetch(emptyDuckDuckGoBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Dentist',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    const providerQueries = fetchMock.mock.calls.map(([input]) => {
      const url = new URL(String(input));
      const page =
        url.searchParams.get('offset') ??
        url.searchParams.get('first') ??
        url.searchParams.get('s') ??
        '0';

      return `${url.hostname}:${page}:${(
        url.searchParams.get('q') ?? url.searchParams.get('p') ?? ''
      ).toLowerCase()}`;
    });

    expect(new Set(providerQueries).size).toBe(providerQueries.length);
  });

  it('uses a bounded second public-search page when query variants are exhausted', async () => {
    const pagedProfileBody = [
      'Title: LinkedIn search results',
      '',
      'Markdown Content:',
      '1. [Jordan Carter - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/jordan-carter-dental/)',
      'Dentist and practice owner in Austin, TX.',
    ].join('\n');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const pageOffset = Number(
        url.searchParams.get('offset') ??
          url.searchParams.get('s') ??
          Math.max(0, Number(url.searchParams.get('first') ?? 1) - 1),
      );

      if (pageOffset >= 10) {
        return makeResponse(pagedProfileBody);
      }

      if (url.hostname === 'html.duckduckgo.com') {
        return makeResponse(emptyDuckDuckGoBody);
      }

      return makeResponse('Title: no public profile matches');
    });

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    const pagedCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = new URL(String(input));
      return Number(
        url.searchParams.get('offset') ??
          url.searchParams.get('s') ??
          Math.max(0, Number(url.searchParams.get('first') ?? 1) - 1),
      ) >= 10;
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.name).toContain('Jordan Carter');
    expect(pagedCalls.length).toBeGreaterThan(0);
  });

  it('keeps an external business website exposed by a public LinkedIn snippet', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Jordan Carter - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/jordan-carter-dental/)',
        'Dentist and practice owner in Austin, TX. Official website: https://austindentalspa.example',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/');
    expect(result.leads[0]?.hasWebsite).toBe(true);
  });

  it('preserves a public website when a later provider omits it', async () => {
    const websiteBody = [
      'Title: LinkedIn search results',
      '',
      'Markdown Content:',
      '1. [Jordan Carter - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/jordan-carter-dental/)',
      'Dentist and practice owner in Austin, TX. Official website: https://austindentalspa.example',
    ].join('\n');
    const sparseBody = [
      'Title: LinkedIn search results',
      '',
      'Markdown Content:',
      '1. [Jordan Carter - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/jordan-carter-dental/)',
      'Owner at Austin Dental Spa in Austin, TX.',
    ].join('\n');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('search.brave.com')) {
        return makeResponse(websiteBody);
      }

      if (url.includes('bing.com')) {
        return makeResponse(sparseBody);
      }

      if (url.includes('html.duckduckgo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
      }

      if (url.includes('search.yahoo.com')) {
        return makeResponse(emptyDuckDuckGoBody);
      }

      throw new Error('Unexpected fetch: ' + url);
    });

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/');
    expect(result.leads[0]?.hasWebsite).toBe(true);
  });

  it('keeps an external business website exposed by a public LinkedIn result title', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Jordan Carter - Owner at Austin Dental Spa | https://austindentalspa.example | LinkedIn](https://www.linkedin.com/in/jordan-carter-dental/)',
        'Dentist and practice owner in Austin, TX.',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.website).toBe('https://austindentalspa.example/');
    expect(result.leads[0]?.hasWebsite).toBe(true);
  });

  it('normalizes www and bare public website domains from LinkedIn snippets', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Jordan Carter - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/jordan-carter-dental/)',
        'Dentist and practice owner in Austin, TX. Website: www.austindentalspa.com',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.website).toBe('https://www.austindentalspa.com/');
    expect(result.leads[0]?.hasWebsite).toBe(true);
  });

  it('does not expose a private-network URL found in a public LinkedIn result', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Jordan Carter - Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/jordan-carter-dental/)',
        'Dentist and practice owner in Austin, TX. Official website: http://127.0.0.1/admin',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.website).toBe('');
    expect(result.leads[0]?.hasWebsite).toBe(false);
  });

  it('rotates mapped category aliases into public LinkedIn company queries', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(emptyDuckDuckGoBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Dentist',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...queries].some((query) => query.includes('dentists'))).toBe(true);
    expect([...queries].some((query) => query.includes('dental offices'))).toBe(true);
  });

  it('adds singular public LinkedIn queries for custom plural categories', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(emptyDuckDuckGoBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Solar installers',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...queries].some((query) => query.includes('Solar installers'))).toBe(true);
    expect([...queries].some((query) => query.includes('Solar installer'))).toBe(true);
  });

  it('covers decision-maker roles for healthcare, education, and dealership categories', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(emptyDuckDuckGoBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Pharmacy',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    const pharmacyQueries = [...queries];
    expect(pharmacyQueries.some((query) => /pharmacy manager|hospital administrator/i.test(query))).toBe(true);

    const schoolFetch = makeQueryCaptureFetch(emptyDuckDuckGoBody);
    vi.stubGlobal('fetch', schoolFetch.fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'School',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...schoolFetch.queries].some((query) => /school principal|admissions director/i.test(query))).toBe(true);

    const dealershipFetch = makeQueryCaptureFetch(emptyDuckDuckGoBody);
    vi.stubGlobal('fetch', dealershipFetch.fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Car dealership',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...dealershipFetch.queries].some((query) => /dealer principal|internet sales manager/i.test(query))).toBe(true);

    const churchFetch = makeQueryCaptureFetch(emptyDuckDuckGoBody);
    vi.stubGlobal('fetch', churchFetch.fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Church',
        city: 'Austin',
        count: 50,
      },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...churchFetch.queries].some((query) => /pastor|church administrator/i.test(query))).toBe(true);
  });

  it('covers decision-maker roles for additional public business sectors', async () => {
    const accountingFetch = makeQueryCaptureFetch(emptyDuckDuckGoBody);
    vi.stubGlobal('fetch', accountingFetch.fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Accounting firm', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...accountingFetch.queries].some((query) => /tax partner|accounting manager|controller/i.test(query))).toBe(true);

    const logisticsFetch = makeQueryCaptureFetch(emptyDuckDuckGoBody);
    vi.stubGlobal('fetch', logisticsFetch.fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Logistics company', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...logisticsFetch.queries].some((query) => /logistics manager|warehouse manager|fleet manager/i.test(query))).toBe(true);

    const fitnessFetch = makeQueryCaptureFetch(emptyDuckDuckGoBody);
    vi.stubGlobal('fetch', fitnessFetch.fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Fitness studio', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...fitnessFetch.queries].some((query) => /studio owner|fitness director|gym manager/i.test(query))).toBe(true);

    const technologyFetch = makeQueryCaptureFetch(emptyDuckDuckGoBody);
    vi.stubGlobal('fetch', technologyFetch.fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Cybersecurity company', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...technologyFetch.queries].some((query) => /it director|engineering manager|vp of engineering/i.test(query))).toBe(true);

    const constructionFetch = makeQueryCaptureFetch(emptyDuckDuckGoBody);
    vi.stubGlobal('fetch', constructionFetch.fetchMock as typeof fetch);

    await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Construction company', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect([...constructionFetch.queries].some((query) => /construction manager|superintendent|preconstruction manager/i.test(query))).toBe(true);
  });

  it('uses concrete metros for timezone searches instead of a timezone label', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(dentalProfileBody);

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: {
        companyType: 'Dentist',
        city: 'Eastern Time',
        count: 350,
      },
      location: {
        ...sampleLocation,
        mode: 'timezone',
        label: 'Eastern Time',
        city: '',
        stateCode: '',
        timeZoneCode: 'ET',
      },
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);

    const queryList = [...queries];
    expect(queryList.length).toBeGreaterThanOrEqual(16);
    expect(queryList.some((query) => /New York(?:,)? NY/i.test(query))).toBe(true);
    expect(queryList.some((query) => /Miami(?:,)? FL/i.test(query))).toBe(true);
    expect(queryList.every((query) => !/Eastern Time/i.test(query))).toBe(true);
  });

  it('keeps an explicit public profile city and state on timezone leads', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Alicia Stone - Dentist in Miami, FL | LinkedIn](https://www.linkedin.com/in/alicia-stone-miami/)',
        'Dentist and practice owner in Miami, FL.',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Eastern Time', count: 50 },
      location: {
        ...sampleLocation,
        mode: 'timezone',
        label: 'Eastern Time',
        city: '',
        stateCode: '',
        timeZoneCode: 'ET',
      },
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.city).toBe('Miami');
    expect(result.leads[0]?.stateCode).toBe('FL');
    expect(result.leads[0]?.address).toBe('Miami, FL');
  });

  it('extracts direct city and full state labels from public profile metadata', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Alicia Stone | Dentist | Miami, Florida | LinkedIn](https://www.linkedin.com/in/alicia-stone-miami/)',
        'Practice owner. Miami, Florida.',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Eastern Time', count: 50 },
      location: {
        ...sampleLocation,
        mode: 'timezone',
        label: 'Eastern Time',
        city: '',
        stateCode: '',
        timeZoneCode: 'ET',
      },
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.city).toBe('Miami');
    expect(result.leads[0]?.stateCode).toBe('FL');
    expect(result.leads[0]?.address).toBe('Miami, FL');
  });

  it('parses bare LinkedIn profile references and unpunctuated city-state evidence', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. Taylor Brooks - Owner at Sunbeam Solar Systems | Professional Profile | LinkedIn linkedin.com › in › taylor-brooks-solar',
        'Owner of a solar installer serving Austin TX.',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Solar installer', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/in/taylor-brooks-solar');
    expect(result.leads[0]?.city).toBe('Austin');
    expect(result.leads[0]?.stateCode).toBe('TX');
  });

  it('keeps operational decision-makers when public results use lowercase state codes', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Jamie Patel - Field Manager at Apex Heating | LinkedIn](https://www.linkedin.com/in/jamie-patel-hvac/)',
        'Field manager for an HVAC contractor serving Austin tx.',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'HVAC Contractors', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.name).toContain('Jamie Patel');
    expect(result.leads[0]?.city).toBe('Austin');
    expect(result.leads[0]?.stateCode).toBe('TX');
    expect(
      [...queries].some((query) => /field manager|service director|installation manager/i.test(query)),
    ).toBe(true);
  });

  it('covers operational roles for custom company types', async () => {
    const { fetchMock, queries } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Jamie Patel - Field Manager at Sunbeam Solar | LinkedIn](https://www.linkedin.com/in/jamie-patel-solar/)',
        'Field manager for a solar installer serving Austin, Texas.',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Solar installer', city: 'Austin', count: 50 },
      location: sampleLocation,
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/in/jamie-patel-solar');
    expect(
      [...queries].some((query) => /field manager|operations manager|general manager/i.test(query)),
    ).toBe(true);
  });

  it('does not invent a location when the public profile has no city and state', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Alicia Stone - Dentist | LinkedIn](https://www.linkedin.com/in/alicia-stone/)',
        'Dentist and practice owner at Austin Dental Spa.',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Eastern Time', count: 50 },
      location: {
        ...sampleLocation,
        mode: 'timezone',
        label: 'Eastern Time',
        city: '',
        stateCode: '',
        timeZoneCode: 'ET',
      },
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.city).toBe('Eastern Time');
    expect(result.leads[0]?.stateCode).toBe('');
    expect(result.leads[0]?.address).toBe('');
  });

  it('does not treat credentials as a public profile location', async () => {
    const { fetchMock } = makeQueryCaptureFetch(
      [
        'Title: LinkedIn search results',
        '',
        'Markdown Content:',
        '1. [Taylor Brooks - Owner at Austin Dental Spa, DDS, PA | LinkedIn](https://www.linkedin.com/in/taylor-brooks-dental/)',
        'Dentist and practice owner at Austin Dental Spa.',
      ].join('\n'),
    );

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromLinkedinSearch({
      request: { companyType: 'Dentist', city: 'Eastern Time', count: 50 },
      location: {
        ...sampleLocation,
        mode: 'timezone',
        label: 'Eastern Time',
        city: '',
        stateCode: '',
        timeZoneCode: 'ET',
      },
      deadlineMs: Date.now() + 20_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.name).toContain('Taylor Brooks');
    expect(result.leads[0]?.address).toBe('');
    expect(result.leads[0]?.stateCode).toBe('');
  });

  it('rejects company pages and unrelated owners even when they use LinkedIn profile URLs', async () => {
    const { fetchMock } = makeQueryCaptureFetch(`Title: LinkedIn search results

Markdown Content:
1. [Lookalike domain profile](https://notlinkedin.com/in/fake-dentist/)
This is not a LinkedIn profile.

1. [Austin Dental Spa - Dentist in Austin | LinkedIn](https://www.linkedin.com/in/austin-dental-spa/)
Dental clinic in Austin, Texas.

2. [Austin Dental Works | LinkedIn](https://www.linkedin.com/in/austin-dental-works/)
Dentist office serving Austin, Texas.

3. [Miami Modern - Miami Modern Dental | LinkedIn](https://www.linkedin.com/in/miami-modern-8916211a3/)
Miami Modern Dental in Austin, Texas.

4. [Dentists in Houston | LinkedIn](https://www.linkedin.com/in/dentists-in-houston/)
Dental referral business in Houston, Texas.

5. [Northwest Austin | LinkedIn](https://www.linkedin.com/in/northwest-austin-106a491a3/)
Northwest Austin Family Dentistry in Austin, Texas.

6. [Taylor Reed - Owner at Reed Roofing | LinkedIn](https://www.linkedin.com/in/taylor-reed-roofing/)
Roofing contractor and owner in Austin, Texas.

7. [Mark Sweeney, DDS - Practice Owner at Austin Dental Spa | LinkedIn](https://www.linkedin.com/in/mark-sweeney-austin/)
Dentist and practice owner at Austin Dental Spa in Austin, Texas.

8. [Jane Doe - Dentist | LinkedIn](https://www.linkedin.com/in/jane-doe-dentist/)
Dentist in Houston, Texas.
`);

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

    expect(result.leads.map((lead) => lead.name)).toEqual(['Mark Sweeney, DDS']);
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/in/mark-sweeney-austin');
  });

  it('rejects snippet-only category matches from academic profiles', async () => {
    const { fetchMock } = makeQueryCaptureFetch(`Title: LinkedIn search results

Markdown Content:
1. [Alex Rivera - Researcher at University of Austin | LinkedIn](https://www.linkedin.com/in/alex-rivera-researcher/)
Researcher studying dental public health in Austin, Texas.
`);

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

    expect(result.leads).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain('No public LinkedIn profiles');
  });

  it('falls back to DuckDuckGo and pauses repeatedly blocked providers', async () => {
    const providerCalls = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const provider = url.includes('search.brave.com')
        ? 'brave'
        : url.includes('bing.com')
          ? 'bing'
          : url.includes('search.yahoo.com')
            ? 'yahoo'
            : 'duckduckgo';
      providerCalls.set(provider, (providerCalls.get(provider) ?? 0) + 1);

      if (provider === 'brave' || provider === 'bing') {
        return makeResponse('Verify you are not a bot. Too many requests.');
      }

      if (provider === 'yahoo') {
        return makeResponse('Yahoo Search is temporarily unavailable.');
      }

      return makeResponse(`<!doctype html><html><body>
<div class="result">
  <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fmark-sweeney-austin%2F" class="result__a">Mark Sweeney - Owner at Austin Dental Spa | LinkedIn</a>
  <a class="result__snippet">Dentist and practice owner at Austin Dental Spa in Austin, Texas.</a>
</div>
</body></html>`);
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
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.listingUrl).toBe('https://linkedin.com/in/mark-sweeney-austin');
    expect(providerCalls.get('brave')).toBe(2);
    expect(providerCalls.get('bing')).toBe(2);
    expect(result.warnings.filter((warning) => warning.providerName === 'Brave Search')).toHaveLength(1);
    expect(result.warnings.filter((warning) => warning.providerName === 'Bing')).toHaveLength(1);
  });
});
