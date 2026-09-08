import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../search-job-store', () => ({
  getSearchDatabasePool: () => database,
  hasSearchDatabase: () => true,
  SearchPersistenceError: class SearchPersistenceError extends Error {
    readonly code = 'SEARCH_PERSISTENCE_UNAVAILABLE';

    constructor(message: string) {
      super(message);
      this.name = 'SearchPersistenceError';
    }
  },
}));

import { lookupIntegrationApiKey } from '../integration-key-store';

describe('integration key store', () => {
  beforeEach(() => {
    database.query.mockReset();
  });

  it('looks up by digest and records last use without handling a raw key', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [{ key_id: 'crm-prod', owner_id: 'owner-1' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(lookupIntegrationApiKey('a'.repeat(64))).resolves.toEqual({
      apiKeyId: 'crm-prod',
      ownerId: 'owner-1',
    });

    expect(database.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('where key_hash = $1'),
      ['a'.repeat(64)],
    );
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('set last_used_at = now()'),
      ['crm-prod'],
    );
  });

  it('fails closed when the key table cannot be read', async () => {
    database.query.mockRejectedValue(new Error('relation does not exist'));

    await expect(lookupIntegrationApiKey('b'.repeat(64))).rejects.toMatchObject({
      code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
    });
  });
});
