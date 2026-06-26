import { describe, expect, it, vi } from 'vitest';

import { httpClient } from '../../utils/http-client';
import { normalizeUsLocation } from '../us-location';

vi.mock('../../utils/http-client', () => ({
  httpClient: {
    get: vi.fn(),
  },
}));

const mockedHttpClient = vi.mocked(httpClient, true);

describe('normalizeUsLocation', () => {
  it('treats USA as a nationwide search scope', async () => {
    const result = await normalizeUsLocation('USA');

    expect(result.mode).toBe('nationwide');
    expect(result.label).toBe('United States');
    expect(result.stateCode).toBe('');
    expect(result.boundingBox.south).toBeLessThan(result.boundingBox.north);
    expect(mockedHttpClient.get).not.toHaveBeenCalled();
  });

  it('normalizes a US time zone query to a canonical zone label', async () => {
    const result = await normalizeUsLocation('EST');

    expect(result.mode).toBe('timezone');
    expect(result.label).toBe('Eastern Time');
    expect(result.timeZoneCode).toBe('ET');
    expect(result.stateCode).toBe('');
    expect(mockedHttpClient.get).not.toHaveBeenCalled();
  });

  it('normalizes a US city/state query to a canonical label', async () => {
    mockedHttpClient.get.mockResolvedValueOnce({
      data: [
        {
          lat: '30.2711286',
          lon: '-97.7436995',
          category: 'boundary',
          type: 'administrative',
          addresstype: 'city',
          name: 'Austin',
          boundingbox: ['30.0985133', '30.5166255', '-97.9367663', '-97.5605288'],
          address: {
            city: 'Austin',
            state: 'Texas',
            country_code: 'us',
          },
        },
      ],
    } as never);

    const result = await normalizeUsLocation('Austin, TX');

    expect(result.label).toBe('Austin, TX');
    expect(result.city).toBe('Austin');
    expect(result.stateCode).toBe('TX');
  });

  it('normalizes a US state query to a canonical state label', async () => {
    mockedHttpClient.get.mockResolvedValueOnce({
      data: [
        {
          lat: '36.778261',
          lon: '-119.4179324',
          category: 'boundary',
          type: 'administrative',
          addresstype: 'state',
          name: 'California',
          boundingbox: ['32.5343', '42.0095', '-124.4096', '-114.1315'],
          address: {
            state: 'California',
            country_code: 'us',
          },
        },
      ],
    } as never);

    const result = await normalizeUsLocation('California');

    expect(result.mode).toBe('local');
    expect(result.label).toBe('California');
    expect(result.city).toBe('California');
    expect(result.stateCode).toBe('CA');
    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      'https://nominatim.openstreetmap.org/search',
      expect.objectContaining({
        params: expect.objectContaining({
          featuretype: 'state',
        }),
      }),
    );
  });

  it('falls back to a coarse city/state location when normalization is rate-limited', async () => {
    mockedHttpClient.get.mockRejectedValueOnce(new Error('Request failed with status code 429'));

    const result = await normalizeUsLocation('Erie, PA');

    expect(result.mode).toBe('local');
    expect(result.label).toBe('Erie, PA');
    expect(result.city).toBe('Erie');
    expect(result.stateCode).toBe('PA');
    expect(result.warnings[0]?.providerId).toBe('nominatim');
    expect(result.warnings[0]?.message).toContain('429');
  });

  it('rejects fuzzy non-place matches like amenities or roads', async () => {
    mockedHttpClient.get.mockResolvedValueOnce({
      data: [
        {
          lat: '41.1492183',
          lon: '-73.2459635',
          category: 'amenity',
          type: 'restaurant',
          addresstype: 'amenity',
          name: 'Bangalore',
          boundingbox: ['41.1490878', '41.1493070', '-73.2461070', '-73.2458200'],
          address: {
            city: 'Fairfield',
            state: 'Connecticut',
            country_code: 'us',
          },
        },
      ],
    } as never);

    await expect(normalizeUsLocation('Bangalore')).rejects.toThrow(
      'No US location match found',
    );
  });
});
