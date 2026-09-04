import { describe, expect, it } from 'vitest';

import { getLeadDiscoveryCandidateTarget } from '../lead-discovery-budget';

describe('getLeadDiscoveryCandidateTarget', () => {
  it('keeps enough headroom for public-phone filtering', () => {
    expect(getLeadDiscoveryCandidateTarget(50)).toBe(100);
    expect(getLeadDiscoveryCandidateTarget(150)).toBe(300);
  });

  it('enforces a useful minimum for small internal batches', () => {
    expect(getLeadDiscoveryCandidateTarget(10)).toBe(60);
  });

  it('caps over-discovery so large searches remain bounded', () => {
    expect(getLeadDiscoveryCandidateTarget(2_000)).toBe(3_000);
  });
});
