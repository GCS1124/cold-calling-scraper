import { afterEach, describe, expect, it, vi } from 'vitest';

describe('research queue memory fallback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prevents duplicate claims and supports retry, completion, and requeue', async () => {
    for (const key of [
      'POSTGRES_URL_NON_POOLING',
      'POSTGRES_PRISMA_URL',
      'POSTGRES_URL',
      'DATABASE_URL',
    ]) {
      vi.stubEnv(key, '');
    }

    const { createResearchQueue } = await import('../research-queue');
    const queue = createResearchQueue();
    await queue.ensureSchema();
    await queue.enqueue('search-queue-1', 1_000);

    const first = await queue.claimNext(1_000, 10_000, 'token-a');
    const duplicate = await queue.claimNext(1_000, 10_000, 'token-b');

    expect(first).toMatchObject({ searchId: 'search-queue-1', attempts: 1, status: 'processing' });
    expect(duplicate).toBeNull();

    await queue.release({
      searchId: 'search-queue-1',
      token: 'token-a',
      status: 'queued',
      now: 1_100,
      retryAt: 2_000,
      error: 'temporary provider timeout',
    });
    expect(await queue.claimNext(1_500, 10_000, 'token-c')).toBeNull();

    const retry = await queue.claimNext(2_000, 10_000, 'token-c');
    expect(retry?.attempts).toBe(2);
    await queue.release({
      searchId: 'search-queue-1',
      token: 'token-c',
      status: 'complete',
      now: 2_100,
    });

    await queue.enqueue('search-queue-1', 3_000);
    const resumed = await queue.claimNext(3_000, 10_000, 'token-d');
    expect(resumed?.searchId).toBe('search-queue-1');
    expect(resumed?.attempts).toBe(3);
    await queue.close();
  });

  it('does not allow a stale lease token to release another worker claim', async () => {
    for (const key of [
      'POSTGRES_URL_NON_POOLING',
      'POSTGRES_PRISMA_URL',
      'POSTGRES_URL',
      'DATABASE_URL',
    ]) {
      vi.stubEnv(key, '');
    }

    const { createResearchQueue } = await import('../research-queue');
    const queue = createResearchQueue();
    await queue.enqueue('search-queue-2', 1_000);
    const claim = await queue.claimNext(1_000, 10, 'token-a');
    expect(claim).not.toBeNull();

    await queue.release({
      searchId: 'search-queue-2',
      token: 'wrong-token',
      status: 'complete',
      now: 1_001,
    });
    expect((await queue.claimNext(1_011, 10, 'token-b'))?.attempts).toBe(2);
    await queue.close();
  });
});
