import { afterEach, describe, expect, it, vi } from 'vitest';

import { httpClient } from '../../utils/http-client';
import { discoverUsLeadsFromOsm, discoverUsLeadsFromOsmBatch } from '../osm-discovery';
import { resolveCategoryProfile } from '../us-category-mapping';
import type { NormalizedUsLocation } from '../us-location';

const localLocation: NormalizedUsLocation = {
  mode: 'local',
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

const easternTimeLocation: NormalizedUsLocation = {
  mode: 'timezone',
  label: 'Eastern Time',
  city: '',
  stateCode: '',
  timeZoneCode: 'ET',
  lat: 37,
  lon: -78,
  boundingBox: {
    south: 24,
    west: -92,
    north: 47,
    east: -67,
  },
  warnings: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('discoverUsLeadsFromOsm', () => {
  it('normalizes a local public listing into a structured lead', async () => {
    const post = vi.spyOn(httpClient, 'post').mockResolvedValue({
      status: 200,
      data: {
        elements: [
          {
            type: 'node',
            id: 101,
            lat: 30.2,
            lon: -97.7,
            tags: {
              name: 'Austin Dental Studio',
              amenity: 'dentist',
              'contact:phone': '+1 512 555 0101',
              'contact:website': 'https://austindental.example',
              'addr:city': 'Austin',
              'addr:state': 'TX',
            },
          },
        ],
      },
    } as never);

    const leads = await discoverUsLeadsFromOsm({
      request: { companyType: 'Dentist', count: 1 },
      location: localLocation,
      profile: resolveCategoryProfile('Dentist'),
      deadlineMs: Date.now() + 2_000,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(leads[0]).toMatchObject({
      name: 'Austin Dental Studio',
      mobile: '+1 512 555 0101',
      website: 'https://austindental.example/',
      hasPhone: true,
      hasWebsite: true,
      source: 'OpenStreetMap',
    });
  });

  it('bounds broad timezone fanout instead of serially exhausting the deadline', async () => {
    let callIndex = 0;
    const post = vi.spyOn(httpClient, 'post').mockImplementation(async () => {
      callIndex += 1;

      return {
        status: 200,
        data: {
          elements: [
            {
              type: 'node',
              id: callIndex,
              lat: 30 + callIndex / 100,
              lon: -90 + callIndex / 100,
              tags: {
                name: `Eastern Dental ${callIndex}`,
                amenity: 'dentist',
              },
            },
          ],
        },
      } as never;
    });

    await discoverUsLeadsFromOsm({
      request: { companyType: 'Dentist', count: 1 },
      location: easternTimeLocation,
      profile: resolveCategoryProfile('Dentist'),
      deadlineMs: Date.now() + 3_000,
    });

    expect(post.mock.calls.length).toBeGreaterThan(1);
    expect(post.mock.calls.length).toBeLessThanOrEqual(12);
    expect(
      new Set(post.mock.calls.slice(0, 3).map(([endpoint]) => endpoint)).size,
    ).toBeGreaterThan(1);
  });

  it('persists a deterministic next-box cursor for durable broad-location continuation', async () => {
    let callIndex = 0;
    vi.spyOn(httpClient, 'post').mockImplementation(async () => {
      callIndex += 1;
      return {
        status: 200,
        data: {
          elements: [{
            type: 'node',
            id: callIndex,
            lat: 30,
            lon: -80,
            tags: {
              name: `Eastern Dental ${callIndex}`,
              amenity: 'dentist',
            },
          }],
        },
      } as never;
    });

    const first = await discoverUsLeadsFromOsmBatch({
      request: { companyType: 'Dentist', count: 1 },
      location: easternTimeLocation,
      profile: resolveCategoryProfile('Dentist'),
      deadlineMs: Date.now() + 3_000,
      maxBoxes: 2,
    });

    expect(first).toMatchObject({
      startBoxCursor: 0,
      nextBoxCursor: 2,
      attemptedBoxCount: 2,
      completedBoxCount: 2,
      completed: false,
    });
    expect(first.totalBoxCount).toBeGreaterThan(2);

    const second = await discoverUsLeadsFromOsmBatch({
      request: { companyType: 'Dentist', count: 1 },
      location: easternTimeLocation,
      profile: resolveCategoryProfile('Dentist'),
      deadlineMs: Date.now() + 3_000,
      boxCursor: first.nextBoxCursor,
      maxBoxes: 2,
    });

    expect(second.startBoxCursor).toBe(2);
    expect(second.nextBoxCursor).toBe(4);
    expect(second.attemptedBoxCount).toBe(2);
  });
});
