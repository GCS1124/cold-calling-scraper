import { describe, expect, it } from 'vitest';

import { filterLeadsForLocation, leadMatchesLocation } from '../location-acceptance';
import type { Lead } from '../../types/lead';
import type { NormalizedUsLocation } from '../us-location';

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'lead-1',
  name: 'Northstar Labs',
  mobile: '',
  email: '',
  website: 'https://northstarlabs.ai',
  address: '123 Congress Ave, Austin, TX 78701',
  category: 'Dental Clinics',
  city: 'Austin, TX',
  source: 'Google Places',
  confidence: 68,
  sourceScore: 95,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: false,
  scrapedAt: '2026-05-21T00:00:00.000Z',
  ...overrides,
});

const austinLocation: NormalizedUsLocation = {
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

const californiaLocation: NormalizedUsLocation = {
  mode: 'local',
  label: 'California',
  city: 'California',
  stateCode: 'CA',
  postalCode: undefined,
  lat: 36.7783,
  lon: -119.4179,
  boundingBox: {
    south: 32.5,
    west: -124.4,
    north: 42,
    east: -114.1,
  },
  warnings: [],
};

const centralTimeLocation: NormalizedUsLocation = {
  mode: 'timezone',
  label: 'Central Time',
  city: 'Central Time',
  stateCode: '',
  timeZoneCode: 'CT',
  postalCode: undefined,
  lat: 39.8283,
  lon: -98.5795,
  boundingBox: {
    south: 25.8371,
    west: -104,
    north: 49,
    east: -82,
  },
  warnings: [],
};

describe('location-acceptance', () => {
  it('accepts exact city/state evidence and rejects same-state outliers or missing addresses', () => {
    const goodLead = makeLead({
      address: '500 Congress Ave, Austin, TX 78701',
      city: 'Austin, TX',
    });
    const sameStateDifferentCity = makeLead({
      id: 'lead-2',
      address: '200 Main St, Round Rock, TX 78664',
      city: 'Round Rock, TX',
    });
    const missingAddress = makeLead({
      id: 'lead-3',
      address: '',
    });

    expect(leadMatchesLocation(goodLead, austinLocation)).toBe(true);
    expect(leadMatchesLocation(sameStateDifferentCity, austinLocation)).toBe(false);
    expect(leadMatchesLocation(missingAddress, austinLocation)).toBe(false);
    expect(filterLeadsForLocation([goodLead, sameStateDifferentCity, missingAddress], austinLocation)).toHaveLength(
      1,
    );
  });

  it('rejects coordinate-only leads when the address cannot prove the location', () => {
    const coordinateOnlyLead = makeLead({
      id: 'lead-4',
      address: '',
      city: '',
      stateCode: '',
      latitude: 30.2672,
      longitude: -97.7431,
    });

    expect(leadMatchesLocation(coordinateOnlyLead, austinLocation)).toBe(false);
    expect(filterLeadsForLocation([coordinateOnlyLead], austinLocation)).toHaveLength(0);
  });

  it('accepts only states inside the selected timezone allow-list', () => {
    const inZoneLead = makeLead({
      address: '500 Congress Ave, Austin, TX 78701',
      city: 'Austin, TX',
    });
    const outOfZoneLead = makeLead({
      id: 'lead-2',
      address: '1000 Market St, San Diego, CA 92101',
      city: 'San Diego, CA',
    });
    const missingStateEvidence = makeLead({
      id: 'lead-3',
      address: 'Suite 200, Example Plaza',
      city: 'Example',
    });
    const coordinateOnlyLead = makeLead({
      id: 'lead-4',
      address: '',
      city: '',
      stateCode: '',
      latitude: 31.0,
      longitude: -95.0,
    });

    expect(leadMatchesLocation(inZoneLead, centralTimeLocation)).toBe(true);
    expect(leadMatchesLocation(outOfZoneLead, centralTimeLocation)).toBe(false);
    expect(leadMatchesLocation(missingStateEvidence, centralTimeLocation)).toBe(false);
    expect(leadMatchesLocation(coordinateOnlyLead, centralTimeLocation)).toBe(false);
    expect(filterLeadsForLocation([inZoneLead, outOfZoneLead, missingStateEvidence], centralTimeLocation)).toHaveLength(
      1,
    );
  });

  it('keeps state-shaped local searches on the confirmed state only', () => {
    const inStateLead = makeLead({
      address: '1000 Capitol Mall, Sacramento, CA 95814',
      city: 'Sacramento, CA',
    });
    const outOfStateLead = makeLead({
      id: 'lead-2',
      address: '500 W 5th St, Reno, NV 89503',
      city: 'Reno, NV',
    });
    const coordinateOnlyLead = makeLead({
      id: 'lead-3',
      address: '',
      city: '',
      stateCode: '',
      latitude: 36.7783,
      longitude: -119.4179,
    });

    expect(leadMatchesLocation(inStateLead, californiaLocation)).toBe(true);
    expect(leadMatchesLocation(outOfStateLead, californiaLocation)).toBe(false);
    expect(leadMatchesLocation(coordinateOnlyLead, californiaLocation)).toBe(false);
    expect(filterLeadsForLocation([inStateLead, outOfStateLead, coordinateOnlyLead], californiaLocation)).toHaveLength(1);
  });
});
