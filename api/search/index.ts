import { ZodError } from 'zod';
import { waitUntil } from '@vercel/functions';
import { searchRequestSchema } from '../_lib/search-contract.js';
import { getVercelSearchService } from '../_lib/vercel-search-service.js';
import { flattenSearchRequest } from '../../server/src/utils/search-location.js';

const isSearchPersistenceFailure = (error: unknown) =>
  error instanceof Error &&
  (error as Error & { code?: unknown }).code === 'SEARCH_PERSISTENCE_UNAVAILABLE';

const isVercelRuntime = () =>
  process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
const durableStorageEnvKeys = [
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL',
  'DATABASE_URL',
] as const;

const hasDurableSearchStorage = () =>
  durableStorageEnvKeys.some((key) => Boolean(process.env[key]?.trim()));

const runStatelessLinkedinSearchOnDemand = async (
  request: ReturnType<typeof flattenSearchRequest>,
) => {
  const { runStatelessLinkedinSearch } = await import(
    '../../server/src/services/linkedin-stateless-search.js'
  );

  return runStatelessLinkedinSearch(request);
};

const runStatelessAiSearchOnDemand = async (
  request: ReturnType<typeof flattenSearchRequest>,
) => {
  const { runStatelessAiSearch } = await import(
    '../../server/src/services/ai-lead-discovery.js'
  );

  return runStatelessAiSearch(request);
};

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let flattenedRequest: ReturnType<typeof flattenSearchRequest> | undefined;

  try {
    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    const payload = searchRequestSchema.parse(req.body);
    flattenedRequest = flattenSearchRequest(payload);

    if (
      isVercelRuntime() &&
      flattenedRequest.sourceMode === 'linkedin' &&
      !hasDurableSearchStorage()
    ) {
      try {
        const response = await runStatelessLinkedinSearchOnDemand(flattenedRequest);
        res.status(200).json(response);
      } catch (error) {
        console.error('[api/search] stateless LinkedIn search failed', error);
        res.status(502).json({
          error: 'Public LinkedIn search could not be completed. Please try again.',
        });
      }
      return;
    }

    if (
      isVercelRuntime() &&
      flattenedRequest.sourceMode === 'ai' &&
      !hasDurableSearchStorage()
    ) {
      try {
        const response = await runStatelessAiSearchOnDemand(flattenedRequest);
        res.status(200).json(response);
      } catch (error) {
        console.error('[api/search] stateless AI search failed', error);
        res.status(502).json({
          error: 'Free AI search could not be completed. Please try again.',
        });
      }
      return;
    }

    const service = await getVercelSearchService();
    const response = await service.startSearch(flattenedRequest);

    waitUntil(
      service.advanceSearch(response.searchId).catch((error) => {
        console.error('[api/search] background search failed', error);
      }),
    );

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Invalid search request',
        details: error.flatten(),
      });
      return;
    }

    if (
      isSearchPersistenceFailure(error) &&
      (flattenedRequest?.sourceMode === 'linkedin' || flattenedRequest?.sourceMode === 'ai')
    ) {
      try {
        const response =
          flattenedRequest.sourceMode === 'ai'
            ? await runStatelessAiSearchOnDemand(flattenedRequest)
            : await runStatelessLinkedinSearchOnDemand(flattenedRequest);
        res.status(200).json(response);
        return;
      } catch (fallbackError) {
        console.error('[api/search] stateless public fallback failed', fallbackError);
        res.status(502).json({
          error:
            flattenedRequest.sourceMode === 'ai'
              ? 'Free AI search could not be completed. Please try again.'
              : 'Public LinkedIn search could not be completed. Please try again.',
        });
        return;
      }
    }

    if (isSearchPersistenceFailure(error)) {
      res.status(503).json({
        error: error instanceof Error ? error.message : 'Search persistence unavailable',
        code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
      });
      return;
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
}
