import {
  getSearchDatabasePool,
  hasSearchDatabase,
  SearchPersistenceError,
} from './search-job-store';

export type StoredIntegrationApiKey = {
  apiKeyId: string;
  ownerId: string;
};

/** Looks up only a digest; raw integration credentials never reach Postgres. */
export const lookupIntegrationApiKey = async (
  keyHash: string,
): Promise<StoredIntegrationApiKey | null> => {
  if (!hasSearchDatabase()) return null;

  const pool = getSearchDatabasePool();
  if (!pool) return null;

  try {
    const result = await pool.query<{
      key_id: string;
      owner_id: string;
    }>(
      `
        select key_id, owner_id
        from public.integration_api_keys
        where key_hash = $1
          and revoked_at is null
          and (expires_at is null or expires_at > now())
        limit 1
      `,
      [keyHash],
    );

    const row = result.rows[0];
    if (!row) return null;

    await pool
      .query(
        `
          update public.integration_api_keys
          set last_used_at = now()
          where key_id = $1
        `,
        [row.key_id],
      )
      .catch((error) => {
        console.error('[integration-key-store] failed to record last use', error);
      });

    return {
      apiKeyId: row.key_id,
      ownerId: row.owner_id,
    };
  } catch (error) {
    console.error('[integration-key-store] lookup failed', error);
    throw new SearchPersistenceError(
      'Integration key storage is unavailable. Check the Postgres connection and migration state.',
    );
  }
};
