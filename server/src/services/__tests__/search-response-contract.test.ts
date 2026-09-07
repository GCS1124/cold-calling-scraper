import { describe, expect, it } from 'vitest';

import {
  buildSearchResponseContract,
  SEARCH_RESPONSE_CONTRACT_VERSION,
} from '../../../../shared/search-contract';

describe('search response contract', () => {
  it.each(['gmb', 'linkedin', 'ai'] as const)('describes %s mode and its phone policy', (mode) => {
    const contract = buildSearchResponseContract(mode);

    expect(contract.contractVersion).toBe(SEARCH_RESPONSE_CONTRACT_VERSION);
    expect(contract.meta.sourceMode).toBe(mode);
    expect(contract.meta.phonePolicy).toEqual({
      required: true,
      evidence: 'public_phone_evidence',
      lineType: 'not_checked',
      reachability: 'not_checked',
      personalOwnership: 'not_checked',
      emailDelivery: 'not_checked',
    });
    expect(contract.meta.limitations.length).toBeGreaterThanOrEqual(4);
    expect(contract.meta.limitations).toContain('Only public, legally accessible sources are used.');
  });
});
