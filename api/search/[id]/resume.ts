import { waitUntil } from '@vercel/functions';
import { getVercelSearchService } from '../../_lib/vercel-search-service.js';

const activeStatuses = new Set(['queued', 'discovering', 'enriching']);

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const searchId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!searchId) {
    res.status(400).json({ error: 'Missing search id' });
    return;
  }

  try {
    const service = await getVercelSearchService();
    const response = await service.resumeSearch(searchId);

    if (!response) {
      res.status(404).json({ error: 'Search not found or already expired' });
      return;
    }

    if (activeStatuses.has(response.meta.status)) {
      waitUntil(
        service.advanceSearch(searchId).catch((error) => {
          console.error('[api/search/:id/resume] background search failed', error);
        }),
      );
    }

    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search resume failed',
    });
  }
}
