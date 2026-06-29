import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('pg', () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const on = vi.fn();

  return {
    Pool: vi.fn().mockImplementation(() => ({
      on,
      query,
      end: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

describe('createSearchJobStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('strips ssl query params before constructing the Postgres pool', async () => {
    vi.stubEnv(
      'POSTGRES_URL',
      'postgres://user:pass@example.com:5432/jobs?sslmode=require&sslaccept=strict',
    );

    const { createSearchJobStore } = await import('../search-job-store');
    const { Pool } = await import('pg');

    const store = createSearchJobStore();
    await store.ensureSchema();

    expect(Pool).toHaveBeenCalledOnce();
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://user:pass@example.com:5432/jobs',
        ssl: {
          rejectUnauthorized: false,
        },
      }),
    );
  });
});
