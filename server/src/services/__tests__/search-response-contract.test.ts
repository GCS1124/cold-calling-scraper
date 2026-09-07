import { describe, expect, it } from 'vitest';

import {
  buildSearchExecutionContract,
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

  it('describes durable and stateless lifecycle behavior explicitly', () => {
    const durable = buildSearchExecutionContract({
      path: 'durable',
      startedAt: '2026-09-08T00:00:00.000Z',
      lastProgressAt: '2026-09-08T00:00:05.000Z',
    });
    const stateless = buildSearchExecutionContract({
      path: 'stateless',
      startedAt: '2026-09-08T00:00:00.000Z',
      lastProgressAt: '2026-09-08T00:00:05.000Z',
    });

    expect(durable).toMatchObject({
      path: 'durable',
      pollable: true,
      resumable: true,
    });
    expect(durable).not.toHaveProperty('completedAt');
    expect(stateless).toMatchObject({
      path: 'stateless',
      pollable: false,
      resumable: false,
      completedAt: '2026-09-08T00:00:05.000Z',
    });
  });
});
