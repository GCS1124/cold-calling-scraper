import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildNotaryCafeSearchQueries,
  discoverUsLeadsFromNotaryCafeIndex,
} from '../notarycafe-search';

const location = {
  mode: 'local' as const,
  label: 'Denver, CO',
  city: 'Denver',
  stateCode: 'CO',
  postalCode: '80236',
  lat: 39.7392,
  lon: -104.9903,
  boundingBox: {
    south: 39,
    west: -105.5,
    north: 40.2,
    east: -104.4,
  },
  warnings: [],
};

const response = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NotaryCafe indexed public search', () => {
  it('does not query the index for an unrelated category', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromNotaryCafeIndex({
      request: { companyType: 'HVAC contractor', city: 'Denver, CO', count: 50 },
      location,
      deadlineMs: Date.now() + 8_000,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.leads).toEqual([]);
    expect(result.coverage).toEqual({
      queriesAttempted: 0,
      providersChecked: 0,
      acceptedCandidates: 0,
    });
  });

  it('builds bounded location-aware search queries without opening NotaryCafe pages', () => {
    const queries = buildNotaryCafeSearchQueries(location, 50);

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(12);
    expect(queries[0]).toContain('site:notarycafe.com');
    expect(queries[0]).toContain('Denver, CO');
    expect(queries[0]).toContain('"Phone"');
  });

  it('turns indexed profile snippets with public phones into normalized leads', async () => {
    const requestedHosts: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);
      return response(`Title: public search results

Markdown Content:
1. [Notary Cafe | Eric Kaufmann Profile](https://notarycafe.com/Eric.Kaufmann)
Phone Text or Call: 303 408 4062
Name: Eric Kaufmann Company Name: Colorado Notary & Signing Agent City: Denver State: CO Zip: 80236
`);
    });

    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const result = await discoverUsLeadsFromNotaryCafeIndex({
      request: { companyType: 'Notary Public', city: 'Denver, CO', count: 50 },
      location,
      deadlineMs: Date.now() + 8_000,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({
      name: 'Eric Kaufmann',
      listingUrl: 'https://notarycafe.com/Eric.Kaufmann',
      mobile: '+13034084062',
      source: 'NotaryCafe, Indexed Public Search',
    });
    expect(result.leads[0]?.contactEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'phone',
          sourceKind: 'public_snippet',
          sourceUrl: 'https://notarycafe.com/Eric.Kaufmann',
        }),
      ]),
    );
    expect(result.coverage.acceptedCandidates).toBe(1);
    expect(requestedHosts).not.toContain('notarycafe.com');
    expect(requestedHosts).not.toContain('www.notarycafe.com');
  });

  it('does not promote an indexed profile when no public US phone is visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(`Title: public search results

Markdown Content:
1. [Notary Cafe | No Phone Profile](https://notarycafe.com/no.phone.profile)
Mobile notary serving Denver, CO.
`),
      ) as typeof fetch,
    );

    const result = await discoverUsLeadsFromNotaryCafeIndex({
      request: { companyType: 'Notary Public', city: 'Denver, CO', count: 50 },
      location,
      deadlineMs: Date.now() + 8_000,
    });

    expect(result.leads).toEqual([]);
    expect(result.warnings.some((warning) => /phone/i.test(warning.message))).toBe(true);
  });

  it('does not promote a local profile when the snippet has no local evidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(`Title: public search results\n\nMarkdown Content:\n1. [Notary Cafe | Unknown Profile](https://notarycafe.com/unknown.profile)\nPhone: (303) 408-4062\n`),
      ) as typeof fetch,
    );

    const result = await discoverUsLeadsFromNotaryCafeIndex({
      request: { companyType: 'Notary Public', city: 'Denver, CO', count: 50 },
      location,
      deadlineMs: Date.now() + 8_000,
    });

    expect(result.leads).toEqual([]);
  });

  it('does not misread the word "in" as the Indiana state code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(`Title: public search results\n\nMarkdown Content:\n1. [Notary Cafe | Denver Signings](https://notarycafe.com/Denver.Signings)\nMobile notary in Denver City: Denver Phone: 303 408 4062\n`),
      ) as typeof fetch,
    );

    const result = await discoverUsLeadsFromNotaryCafeIndex({
      request: { companyType: 'Notary Public', city: 'Denver, CO', count: 50 },
      location,
      deadlineMs: Date.now() + 8_000,
    });

    expect(result.leads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Denver Signings', city: 'Denver', stateCode: 'CO' }),
      ]),
    );
  });

  it('merges repeated profile snippets so later phone evidence is not discarded', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount += 1;
        const body = callCount === 1
          ? `Title: public search results\n\nMarkdown Content:\n1. [Notary Cafe | Eric Kaufmann Profile](https://notarycafe.com/Eric.Kaufmann)\nCity: Denver\n`
          : `Title: public search results\n\nMarkdown Content:\n1. [Notary Cafe | Eric Kaufmann Profile](https://notarycafe.com/Eric.Kaufmann)\nPhone: (303) 408-4062 Company Name: Colorado Notary & Signing Agent State: CO\n`;

        return response(body);
      }) as typeof fetch,
    );

    const result = await discoverUsLeadsFromNotaryCafeIndex({
      request: { companyType: 'Notary Public', city: 'Denver, CO', count: 50 },
      location,
      deadlineMs: Date.now() + 8_000,
    });

    expect(result.leads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Eric Kaufmann',
          organizationName: 'Colorado Notary & Signing Agent',
          mobile: '+13034084062',
        }),
      ]),
    );
  });

  it('rejects an indexed profile whose explicit state conflicts with a local request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(`Title: public search results\n\nMarkdown Content:\n1. [Notary Cafe | Texas Profile](https://notarycafe.com/texas.profile)\nPhone: (512) 555-0101 Name: Texas Profile State: TX\n`),
      ) as typeof fetch,
    );

    const result = await discoverUsLeadsFromNotaryCafeIndex({
      request: { companyType: 'Notary Public', city: 'Denver, CO', count: 50 },
      location,
      deadlineMs: Date.now() + 8_000,
    });

    expect(result.leads).toEqual([]);
    expect(result.warnings.some((warning) => /none exposed|phone/i.test(warning.message))).toBe(true);
  });

  it('rejects a same-state profile whose indexed city contradicts a local request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(`Title: public search results\n\nMarkdown Content:\n1. [Houston Notary](https://notarycafe.com/Houston.Notary)\nHouston, TX Phone: (713) 555-0199\n`),
      ) as typeof fetch,
    );

    const result = await discoverUsLeadsFromNotaryCafeIndex({
      request: { companyType: 'Notary Public', city: 'Austin, TX', count: 50 },
      location: {
        ...location,
        label: 'Austin, TX',
        city: 'Austin',
        stateCode: 'TX',
        postalCode: '78701',
      },
      deadlineMs: Date.now() + 8_000,
    });

    expect(result.leads).toEqual([]);
  });
});
