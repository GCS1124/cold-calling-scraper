import { describe, expect, it } from 'vitest';

import { companyTypeOptions } from '../data/search-options';

describe('company type options', () => {
  it('includes Google Business style keywords and legacy labels', () => {
    expect(companyTypeOptions).toEqual(
      expect.arrayContaining([
        'Dentist',
        'Dental Clinics',
        'Orthodontist',
        'Plumber',
        'Plumbers',
        'HVAC contractor',
        'HVAC Contractors',
        'Real estate agent',
        'Real Estate Agencies',
        'Attorney',
        'Law Firms',
        'Urgent care',
        'Medical Clinics',
        'Mechanic',
        'Auto Repair',
        'SEO agency',
        'Marketing Agencies',
        'Commercial cleaning',
        'Cleaning Services',
      ]),
    );
  });
});
