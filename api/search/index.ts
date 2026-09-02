import { ZodError } from 'zod';
import { waitUntil } from '@vercel/functions';
import { searchRequestSchema } from '../_lib/search-contract.js';
import { getVercelSearchService } from '../_lib/vercel-search-service.js';
import { flattenSearchRequest } from '../../server/src/utils/search-location.js';

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    const payload = searchRequestSchema.parse(req.body);
    const service = await getVercelSearchService();
    const response = await service.startSearch(flattenSearchRequest(payload));

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

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
}
