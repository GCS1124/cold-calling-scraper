import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { createResearchQueue } from './services/research-queue';
import { createSearchJobStore } from './services/search-job-store';
import { vercelSearchService } from './services/vercel-search-service';

const activeStatuses = new Set(['queued', 'discovering', 'enriching']);
const leaseMs = Number(process.env.RESEARCH_WORKER_LEASE_MS ?? 90_000);
const pollMs = Number(process.env.RESEARCH_WORKER_POLL_MS ?? 1_000);
const retryMs = Number(process.env.RESEARCH_WORKER_RETRY_MS ?? 5_000);
const maxAttempts = Number(process.env.RESEARCH_WORKER_MAX_ATTEMPTS ?? 4);

export const runResearchWorkerOnce = async () => {
  const searchStore = createSearchJobStore();
  const queue = createResearchQueue();
  await searchStore.ensureSchema();
  await queue.ensureSchema();

  const token = randomUUID();
  const item = await queue.claimNext(Date.now(), leaseMs, token);
  if (!item) {
    await queue.close();
    return false;
  }

  try {
    const response = await vercelSearchService.advanceSearch(item.searchId);
    const terminal = !response || !activeStatuses.has(response.meta.status);
    await queue.release({
      searchId: item.searchId,
      token,
      status: terminal || item.attempts >= maxAttempts ? (terminal ? 'complete' : 'dead') : 'queued',
      now: Date.now(),
      retryAt: terminal ? undefined : Date.now() + 50,
      error: terminal ? undefined : 'Search remains active after worker tick',
    });
  } catch (error) {
    await queue.release({
      searchId: item.searchId,
      token,
      status: item.attempts >= maxAttempts ? 'dead' : 'queued',
      now: Date.now(),
      retryAt: item.attempts >= maxAttempts ? undefined : Date.now() + retryMs * item.attempts,
      error: error instanceof Error ? error.message : 'Worker tick failed',
    });
  } finally {
    await queue.close();
  }

  return true;
};

const main = async () => {
  if (!process.env.POSTGRES_URL_NON_POOLING && !process.env.POSTGRES_PRISMA_URL && !process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    throw new Error('Research worker requires a Postgres/Supabase connection string.');
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log('Lead Finder research worker started.');
  while (!stopping) {
    const processed = await runResearchWorkerOnce();
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  console.log('Lead Finder research worker stopped.');
};

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
