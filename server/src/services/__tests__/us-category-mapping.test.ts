import { describe, expect, it } from 'vitest';

import { resolveCategoryProfile } from '../us-category-mapping';

describe('resolveCategoryProfile', () => {
  it('maps Google Business style dental keywords to the dental profile', () => {
    const profile = resolveCategoryProfile('Orthodontist');

    expect(profile.label).toBe('Dental Clinics');
    expect(profile.searchTerms).toEqual(
      expect.arrayContaining(['orthodontist', 'dental clinic', 'cosmetic dentist']),
    );
  });

  it('maps service keywords to the hvac profile', () => {
    const profile = resolveCategoryProfile('AC repair');

    expect(profile.label).toBe('HVAC Contractors');
    expect(profile.searchTerms).toEqual(
      expect.arrayContaining([
        'ac repair',
        'air conditioning repair',
        'air conditioning company',
        'hvac repair',
        'furnace repair',
      ]),
    );
  });

  it('maps commercial cleaning keywords to the cleaning profile', () => {
    const profile = resolveCategoryProfile('Commercial cleaning');

    expect(profile.label).toBe('Cleaning Services');
    expect(profile.searchTerms).toEqual(
      expect.arrayContaining(['commercial cleaning', 'commercial cleaner', 'maid service']),
    );
  });
});
