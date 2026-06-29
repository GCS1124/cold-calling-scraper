import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { googlePlacesProvider } from '../google-places';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const mockedGet = vi.mocked(axios.get);
const mockedPost = vi.mocked(axios.post);

describe('googlePlacesProvider', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_PLACES_API_KEY;
  });

  it('uses multiple query variants and paginates beyond the first page', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';

    mockedPost.mockImplementation(async (url) => {
      const endpoint = String(url);
      if (endpoint.includes('places.googleapis.com/v1/places:searchText')) {
        return {
          data: {
            places: [],
          },
        };
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    mockedGet.mockImplementation(async (url, config) => {
      const endpoint = String(url);
      const params = (config as { params?: Record<string, string | undefined> } | undefined)?.params ?? {};

      if (endpoint.includes('/textsearch/')) {
        const query = params.query ?? '';
        const pageToken = params.pagetoken ?? '';

        if (query === 'Dentist in Austin, TX' && !pageToken) {
          return {
            data: {
              status: 'OK',
              results: [
                { place_id: 'place-1', name: 'Northstar Dental' },
                { place_id: 'place-2', name: 'Lone Star Smile' },
              ],
              next_page_token: 'page-2',
            },
          };
        }

        if (query === 'Dentist in Austin, TX' && pageToken === 'page-2') {
          return {
            data: {
              status: 'OK',
              results: [
                { place_id: 'place-3', name: 'Capitol Dental' },
              ],
            },
          };
        }

        if (query === 'Dental office in Austin, TX') {
          return {
            data: {
              status: 'OK',
              results: [
                { place_id: 'place-4', name: 'Congress Dental' },
              ],
            },
          };
        }

        return {
          data: {
            status: 'ZERO_RESULTS',
            results: [],
          },
        };
      }

      if (endpoint.includes('/details/')) {
        const placeId = params.place_id as string | undefined;

        return {
          data: {
            status: 'OK',
            result: {
              place_id: placeId,
              name: placeId === 'place-1' ? 'Northstar Dental' : 'Result Name',
              formatted_phone_number: '(512) 555-0101',
              international_phone_number: '+1 512 555 0101',
              website: 'northstardental.com',
              formatted_address: 'Austin, TX',
            },
          },
        };
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    const leads = await googlePlacesProvider.fetchLeads({
      rawQuery: 'Dental Clinics',
      query: 'Dentist in Austin, TX',
      queryVariants: ['Dental office in Austin, TX'],
      request: {
        companyType: 'Dental Clinics',
        city: 'Austin, TX',
        count: 50,
      },
      deadlineMs: Date.now() + 15_000,
    });

    expect(leads).toHaveLength(4);
    expect(mockedGet.mock.calls.filter(([url]) => String(url).includes('/textsearch/')).length).toBeGreaterThan(2);
    expect(mockedGet.mock.calls.some(([, config]) => (config as { params?: { query?: string } }).params?.query === 'Dental office in Austin, TX')).toBe(true);
    expect(mockedGet.mock.calls.some(([, config]) => (config as { params?: { pagetoken?: string } }).params?.pagetoken === 'page-2')).toBe(true);
  });

  it('expands with category synonyms before falling back to legacy when baseline new results are short', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';

    const seenQueries: string[] = [];

    mockedGet.mockImplementation(async (url) => {
      const endpoint = String(url);
      if (endpoint.includes('/textsearch/')) {
        throw new Error('Legacy fallback should not run when category expansion is enough');
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    mockedPost.mockImplementation(async (url, body, config) => {
      const endpoint = String(url);
      const textQuery = String((body as { textQuery?: string } | undefined)?.textQuery ?? '');

      if (endpoint.includes('places.googleapis.com/v1/places:searchText')) {
        seenQueries.push(textQuery);
        expect(body).toMatchObject({
          includePureServiceAreaBusinesses: true,
          languageCode: 'en',
          regionCode: 'us',
          pageSize: 20,
        });
        if (seenQueries.length === 1) {
          expect(body).toMatchObject({
            textQuery: 'Dentist in Austin, TX',
          });
        }
        expect((config as { headers?: Record<string, string> } | undefined)?.headers?.['X-Goog-FieldMask']).toContain(
          'places.displayName',
        );

        return {
          data: {
            places: [
              {
                id: textQuery.toLowerCase() === 'dental clinic in austin, tx' ? 'place-new-2' : 'place-new-1',
                displayName: {
                  text:
                    textQuery.toLowerCase() === 'dental clinic in austin, tx'
                      ? 'Premier Dental Clinic'
                      : 'Northstar Dental',
                },
                formattedAddress: 'Austin, TX',
                nationalPhoneNumber: '(512) 555-0101',
                websiteUri:
                  textQuery.toLowerCase() === 'dental clinic in austin, tx'
                    ? 'premierdentalclinic.com'
                    : 'northstardental.com',
              },
            ],
          },
        };
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    const leads = await googlePlacesProvider.fetchLeads({
      rawQuery: 'Dental Clinics',
      query: 'Dentist in Austin, TX',
      queryVariants: ['Dental office in Austin, TX'],
      request: {
        companyType: 'Dental Clinics',
        city: 'Austin, TX',
        count: 2,
      },
      deadlineMs: Date.now() + 15_000,
    });

    expect(leads).toHaveLength(2);
    expect(leads[0]?.id).toBe('google-place-new-1');
    expect(leads[1]?.id).toBe('google-place-new-2');
    expect(seenQueries.map((value) => value.toLowerCase())).toEqual([
      'dentist in austin, tx',
      'dental office in austin, tx',
      'dental clinic in austin, tx',
    ]);
    expect(mockedGet.mock.calls.some(([url]) => String(url).includes('/textsearch/'))).toBe(false);
  });

  it('keeps collecting Austin-specific expansion queries after the first raw 60 candidates', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';

    const seenQueries: string[] = [];
    const austinLocation = {
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

    mockedGet.mockImplementation(async (url, config) => {
      const endpoint = String(url);
      const params = (config as { params?: Record<string, string | undefined> } | undefined)?.params ?? {};

      if (endpoint.includes('/textsearch/')) {
        return {
          data: {
            status: 'ZERO_RESULTS',
            results: [],
          },
        };
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    mockedPost.mockImplementation(async (url, body) => {
      const endpoint = String(url);
      if (endpoint.includes('places.googleapis.com/v1/places:searchText')) {
        const textQuery = String((body as { textQuery?: string } | undefined)?.textQuery ?? '');
        const pageToken = String((body as { pageToken?: string } | undefined)?.pageToken ?? '');

        if (textQuery === 'HVAC Contractors in Austin, TX' && !pageToken) {
          return {
            data: {
              places: Array.from({ length: 20 }, (_, index) => ({
                id: `baseline-${index + 1}`,
                displayName: {
                  text: `Austin HVAC ${index + 1}`,
                },
                formattedAddress: `Austin, TX 7870${index % 10}`,
                nationalPhoneNumber: `(512) 555-0${String(index + 1).padStart(3, '0')}`,
                websiteUri: `austin-hvac-${index + 1}.example.com`,
              })),
              nextPageToken: 'page-2',
            },
          };
        }

        if (textQuery === 'HVAC Contractors in Austin, TX' && pageToken === 'page-2') {
          return {
            data: {
              places: Array.from({ length: 20 }, (_, index) => ({
                id: `baseline-${index + 21}`,
                displayName: {
                  text: `Austin HVAC ${index + 21}`,
                },
                formattedAddress: `Austin, TX 7871${index % 10}`,
                nationalPhoneNumber: `(512) 555-1${String(index + 1).padStart(3, '0')}`,
                websiteUri: `austin-hvac-${index + 21}.example.com`,
              })),
              nextPageToken: 'page-3',
            },
          };
        }

        if (textQuery === 'HVAC Contractors in Austin, TX' && pageToken === 'page-3') {
          return {
            data: {
              places: Array.from({ length: 20 }, (_, index) => ({
                id: `baseline-${index + 41}`,
                displayName: {
                  text: `Austin HVAC ${index + 41}`,
                },
                formattedAddress: `Austin, TX 7872${index % 10}`,
                nationalPhoneNumber: `(512) 555-2${String(index + 1).padStart(3, '0')}`,
                websiteUri: `austin-hvac-${index + 41}.example.com`,
              })),
            },
          };
        }

        seenQueries.push(textQuery);

        if (/austin (area|metro|metro area|downtown|north|south|east|west)|greater austin/i.test(textQuery)) {
          return {
            data: {
              places: [
                {
                  id: 'expanded-austin-1',
                  displayName: {
                    text: 'Greater Austin HVAC',
                  },
                  formattedAddress: 'Austin, TX 78703',
                  nationalPhoneNumber: '(512) 555-9999',
                  websiteUri: 'greater-austin-hvac.example.com',
                },
              ],
            },
          };
        }

        return {
          data: {
            places: [],
          },
        };
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    const leads = await googlePlacesProvider.fetchLeads({
      rawQuery: 'HVAC Contractors',
      query: 'HVAC Contractors in Austin, TX',
      request: {
        companyType: 'HVAC Contractors',
        city: 'Austin, TX',
        count: 50,
      },
      location: austinLocation,
      deadlineMs: Date.now() + 15_000,
    });

    expect(leads).toHaveLength(61);
    expect(seenQueries.some((value) => /austin (area|metro|metro area|downtown|north|south|east|west)|greater austin/i.test(value))).toBe(true);
  });

  it('falls back to legacy Places only after expanded Places API (New) queries still come up short', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';

    const searchOrder: string[] = [];

    mockedGet.mockImplementation(async (url, config) => {
      const endpoint = String(url);
      const params = (config as { params?: Record<string, string | undefined> } | undefined)?.params ?? {};

      if (endpoint.includes('/textsearch/')) {
        searchOrder.push(`legacy:${params.query ?? ''}`);
        const query = params.query ?? '';

        if (query === 'Dentist in Austin, TX') {
          return {
            data: {
              status: 'OK',
              results: [
                { place_id: 'place-legacy-1', name: 'Congress Dental', formatted_address: 'Austin, TX' },
              ],
            },
          };
        }

        return {
          data: {
            status: 'ZERO_RESULTS',
            results: [],
          },
        };
      }

      if (endpoint.includes('/details/')) {
        const placeId = params.place_id as string | undefined;

        return {
          data: {
            status: 'OK',
            result: {
              place_id: placeId,
              name: 'Congress Dental',
              formatted_phone_number: '(512) 555-0202',
              international_phone_number: '+1 512 555 0202',
              website: 'congressdental.com',
              formatted_address: 'Austin, TX',
            },
          },
        };
      }

      if (endpoint.includes('/v1/places/')) {
        throw new Error('Unexpected Places API (New) details request');
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    mockedPost.mockImplementation(async (url, body) => {
      const endpoint = String(url);
      const textQuery = String((body as { textQuery?: string } | undefined)?.textQuery ?? '');

      if (endpoint.includes('places.googleapis.com/v1/places:searchText')) {
        searchOrder.push(`new:${textQuery}`);

        if (textQuery.toLowerCase() === 'dentist in austin, tx') {
          return {
            data: {
              places: [
                {
                  id: 'place-new-1',
                  displayName: {
                    text: 'Northstar Dental',
                  },
                  formattedAddress: 'Austin, TX',
                  nationalPhoneNumber: '(512) 555-0101',
                  websiteUri: 'northstardental.com',
                },
              ],
            },
          };
        }

        return {
          data: {
            places: [],
          },
        };
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    const leads = await googlePlacesProvider.fetchLeads({
      rawQuery: 'Dental Clinics',
      query: 'Dentist in Austin, TX',
      queryVariants: ['Dental office in Austin, TX'],
      request: {
        companyType: 'Dental Clinics',
        city: 'Austin, TX',
        count: 2,
      },
      deadlineMs: Date.now() + 15_000,
    });

    expect(leads).toHaveLength(2);
    expect(searchOrder.some((entry) => entry.toLowerCase().startsWith('new:dental clinic in austin, tx'))).toBe(true);
    expect(searchOrder.some((entry) => entry.startsWith('legacy:'))).toBe(true);
    expect(
      searchOrder.findIndex((entry) => entry.startsWith('legacy:')),
    ).toBeGreaterThan(
      searchOrder.findIndex((entry) => entry.toLowerCase().startsWith('new:dental clinic in austin, tx')),
    );
    expect(leads[0]?.id).toBe('google-place-new-1');
    expect(leads[1]?.id).toBe('google-place-legacy-1');
    expect(leads[1]?.name).toBe('Congress Dental');
  });

  it('keeps partial Google results when a later page or detail call fails', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';

    mockedGet.mockImplementation(async (url, config) => {
      const endpoint = String(url);
      const params = (config as { params?: Record<string, string | undefined> } | undefined)?.params ?? {};

      if (endpoint.includes('/textsearch/')) {
        const query = params.query ?? '';
        const pageToken = params.pagetoken ?? '';

        if (query === 'Dentist in Austin, TX' && !pageToken) {
          return {
            data: {
              status: 'OK',
              results: [
                { place_id: 'place-1', name: 'Northstar Dental', formatted_address: 'Austin, TX' },
                { place_id: 'place-2', name: 'Lone Star Smile', formatted_address: 'Austin, TX' },
              ],
              next_page_token: 'page-2',
            },
          };
        }

        if (query === 'Dentist in Austin, TX' && pageToken === 'page-2') {
          return {
            data: {
              status: 'INVALID_REQUEST',
            },
          };
        }

        return {
          data: {
            status: 'ZERO_RESULTS',
            results: [],
          },
        };
      }

      if (endpoint.includes('/details/')) {
        const placeId = params.place_id as string | undefined;

        if (placeId === 'place-1') {
          return {
            data: {
              status: 'OK',
              result: {
                place_id: placeId,
                name: 'Northstar Dental',
                formatted_phone_number: '(512) 555-0101',
                international_phone_number: '+1 512 555 0101',
                website: 'northstardental.com',
                formatted_address: 'Austin, TX',
              },
            },
          };
        }

        return {
          data: {
            status: 'INVALID_REQUEST',
          },
        };
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    mockedPost.mockImplementation(async (url) => {
      const endpoint = String(url);
      if (endpoint.includes('places.googleapis.com/v1/places:searchText')) {
        return {
          data: {
            places: [],
          },
        };
      }

      throw new Error(`Unexpected request: ${endpoint}`);
    });

    const leads = await googlePlacesProvider.fetchLeads({
      rawQuery: 'Dental Clinics',
      query: 'Dentist in Austin, TX',
      request: {
        companyType: 'Dental Clinics',
        city: 'Austin, TX',
        count: 50,
      },
      deadlineMs: Date.now() + 15_000,
    });

    expect(leads).toHaveLength(2);
    expect(leads[0]?.id).toBe('google-place-1');
    expect(leads[0]?.name).toBe('Northstar Dental');
    expect(leads[1]?.id).toBe('google-place-2');
    expect(leads[1]?.name).toBe('Lone Star Smile');
    expect(leads[1]?.mobile).toBe('');
    expect(leads[1]?.website).toBe('');
  });
});
