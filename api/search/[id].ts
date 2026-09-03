import { waitUntil } from '@vercel/functions';
import { getSearchJobSnapshot } from '../../server/src/services/search-job-snapshot.js';
import { getVercelSearchService } from '../_lib/vercel-search-service.js';

const activeSearchStatuses = new Set(['queued', 'discovering', 'enriching']);

const isSearchPersistenceFailure = (error: unknown) =>
  error instanceof Error &&
  (error as Error & { code?: unknown }).code === 'SEARCH_PERSISTENCE_UNAVAILABLE';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const searchId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!searchId) {
    res.status(400).json({ error: 'Missing search id' });
    return;
  }

  try {
    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    const response = await getSearchJobSnapshot(searchId);
    if (!response) {
      res.status(204).end();
      return;
    }

    if (activeSearchStatuses.has(response.meta.status)) {
      waitUntil(
        getVercelSearchService()
          .then((service) => service.advanceSearch(searchId))
          .catch((error) => {
            console.error('[api/search/:id] background search failed', error);
          }),
      );
    }

    res.status(200).json(response);
  } catch (error) {
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
