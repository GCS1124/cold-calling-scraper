import { ZodError } from 'zod';
import { waitUntil } from '@vercel/functions';
import { searchRequestSchema } from '../_lib/search-contract.js';
import { getVercelSearchService } from '../_lib/vercel-search-service.js';
import { flattenSearchRequest } from '../../server/src/utils/search-location.js';
import { runStatelessLinkedinSearch } from '../../server/src/services/linkedin-stateless-search.js';

const isSearchPersistenceFailure = (error: unknown) =>
  error instanceof Error &&
  (error as Error & { code?: unknown }).code === 'SEARCH_PERSISTENCE_UNAVAILABLE';

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

    if (isSearchPersistenceFailure(error) && flattenedRequest?.sourceMode === 'linkedin') {
      try {
        const response = await runStatelessLinkedinSearch(flattenedRequest);
        res.status(200).json(response);
        return;
      } catch (fallbackError) {
        console.error('[api/search] stateless LinkedIn fallback failed', fallbackError);
        res.status(502).json({
          error: 'Public LinkedIn search could not be completed. Please try again.',
        });
        return;
      }
    }

    if (isSearchPersistenceFailure(error)) {
      res.status(503).json({
        error: error.message,
        code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
      });
      return;
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
}
