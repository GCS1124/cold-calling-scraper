import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn().mockResolvedValue({ rows: [] });
const database = { query };

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

import {
  ensureIntegrationAuditReady,
  recordIntegrationAuditEvent,
} from '../integration-audit-log';

describe('integration audit log', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.LEAD_FINDER_INTEGRATION_AUDIT_MODE;
    delete process.env.LEAD_FINDER_INTEGRATION_AUDIT_RETENTION_DAYS;
  });

  it('writes bounded request metadata without a raw credential or query string', async () => {
    await recordIntegrationAuditEvent({
      requestId: 'req-123',
      ownerId: 'owner-123',
      apiKeyId: 'key-123',
      method: 'post',
      path: '/api/v1/search?secret=should-not-be-stored',
      operation: 'POST /api/v1/search',
      outcome: 'completed',
      statusCode: 200,
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('insert into public.integration_audit_events');
    expect(values).not.toContain('should-not-be-stored');
    expect(values).not.toContain('lfp_raw_secret');
    expect(values).toContain('owner-123');
    expect(values).toContain('key-123');
  });

  it('checks the audit table when required mode is enabled', async () => {
    process.env.LEAD_FINDER_INTEGRATION_AUDIT_MODE = 'required';

    await ensureIntegrationAuditReady();

    expect(query).toHaveBeenCalledWith(
      'select 1 from public.integration_audit_events limit 0',
    );
  });
});
