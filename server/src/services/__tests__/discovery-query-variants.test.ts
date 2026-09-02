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
    expect(queries.length).toBe(80);
    expect(
      queries.some(
        (query) => query.startsWith('hvac ') || query.startsWith('air conditioning '),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (query) =>
          query.includes('Austin') &&
          (query.startsWith('air conditioning') ||
            query.startsWith('hvac repair') ||
            query.startsWith('air conditioning company')),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (query) =>
          query.startsWith('hvac repair') ||
          query.startsWith('air conditioning company') ||
          query.startsWith('duct cleaning'),
      ),
    ).toBe(true);
  });

  it('includes mapped profile aliases for broader public LinkedIn coverage', () => {
    const profile = resolveCategoryProfile('Dentist');
    const queries = buildDiscoveryQueryVariants('Dentist', austinLocation, profile);

    expect(queries).toContain('dentists in Austin, TX');
  });

  it('singularizes custom plural business inputs for public discovery', () => {
    const profile = resolveCategoryProfile('Solar installers');
    const queries = buildDiscoveryQueryVariants('Solar installers', austinLocation, profile);

    expect(queries).toContain('Solar installers in Austin, TX');
    expect(queries).toContain('Solar installer in Austin, TX');
  });
});
