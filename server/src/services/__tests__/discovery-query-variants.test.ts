import { describe, expect, it } from 'vitest';

import { buildDiscoveryQueryVariants } from '../discovery-query-variants';
import { resolveCategoryProfile } from '../us-category-mapping';

const austinLocation = {
  mode: 'local' as const,
  label: 'Austin, TX',
  city: 'Austin',
  stateCode: 'TX',
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

describe('buildDiscoveryQueryVariants', () => {
  it('interleaves synonym terms before exhausting the Austin location permutations', () => {
    const profile = resolveCategoryProfile('HVAC Contractors');
    const queries = buildDiscoveryQueryVariants('HVAC Contractors', austinLocation, profile);

    expect(queries[0]).toBe('HVAC Contractors in Austin, TX');
    expect(queries.length).toBe(60);
    expect(
      queries.some(
        (query) => query.startsWith('hvac ') || query.startsWith('air conditioning '),
      ),
    ).toBe(true);
    expect(
      queries.some((query) => query.includes('Austin') && query.startsWith('air conditioning')),
    ).toBe(true);
  });
});
