import { ZodError } from 'zod';
import { searchRequestSchema } from '../_lib/search-contract.js';
import { vercelSearchService } from '../../server/src/services/vercel-search-service.js';
import { flattenSearchRequest } from '../../server/src/utils/search-location.js';

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const payload = searchRequestSchema.parse(req.body);
    const response = await vercelSearchService.startSearch(flattenSearchRequest(payload));
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
