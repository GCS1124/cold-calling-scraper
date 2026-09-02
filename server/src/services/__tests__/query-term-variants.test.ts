import { describe, expect, it } from 'vitest';

import { buildQueryTermVariants } from '../query-term-variants';

describe('buildQueryTermVariants', () => {
  it('adds a singular form for common plural business terms', () => {
    expect(buildQueryTermVariants('Solar installers')).toEqual([
      'Solar installers',
      'Solar installer',
    ]);
    expect(buildQueryTermVariants('Dental offices')).toEqual([
      'Dental offices',
      'Dental office',
    ]);
    expect(buildQueryTermVariants('Companies')).toEqual(['Companies', 'Company']);
  });

  it('does not damage words whose trailing s is not a plural suffix', () => {
    expect(buildQueryTermVariants('Business')).toEqual(['Business']);
    expect(buildQueryTermVariants('Gas')).toEqual(['Gas']);
    expect(buildQueryTermVariants('News')).toEqual(['News']);
  });
});
