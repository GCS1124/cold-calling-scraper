import { describe, expect, it } from 'vitest';

import { getResearchDepthConfig, normalizeResearchDepth } from '../research-depth';

describe('research depth', () => {
  it('defaults unknown or missing values to the verified profile', () => {
    expect(normalizeResearchDepth()).toBe('verified');
    expect(normalizeResearchDepth('unsupported')).toBe('verified');
    expect(getResearchDepthConfig(undefined).maxQueryFamilies).toBe(12);
  });

  it('keeps quick bounded and pro deeper than the verified profile', () => {
    const quick = getResearchDepthConfig('quick');
    const verified = getResearchDepthConfig('verified');
    const pro = getResearchDepthConfig('pro');

    expect(quick.secondPageQueryLimit).toBe(0);
    expect(quick.maxQueryFamilies).toBeLessThan(verified.maxQueryFamilies);
    expect(pro.maxQueryFamilies).toBeGreaterThan(verified.maxQueryFamilies);
    expect(pro.googleMapsQueryLimit).toBeGreaterThan(verified.googleMapsQueryLimit);
  });
});
