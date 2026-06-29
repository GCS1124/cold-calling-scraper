import { vercelSearchService } from '../../server/src/services/vercel-search-service.js';

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
    const response = await vercelSearchService.getSearch(searchId);
    if (!response) {
      res.status(204).end();
      return;
    }

    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
}
