import { waitUntil } from '@vercel/functions';
import { getVercelSearchService } from '../../_lib/vercel-search-service.js';
import {
  getRequestId,
  sendSearchError,
  setRequestIdHeader,
  withSearchRequestId,
} from '../../../server/src/http/search-http-contract.js';

const activeStatuses = new Set(['queued', 'discovering', 'enriching']);

export default async function handler(req: any, res: any) {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  if (req.method !== 'POST') {
    sendSearchError(res, 405, {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed',
      retryable: false,
      requestId,
    });
    return;
  }

  const searchId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!searchId) {
    sendSearchError(res, 400, {
      code: 'MISSING_SEARCH_ID',
      message: 'Missing search id',
      retryable: false,
      requestId,
    });
    return;
  }

  try {
    const service = await getVercelSearchService();
    const response = await service.resumeSearch(searchId);

    if (!response) {
      sendSearchError(res, 404, {
        code: 'SEARCH_NOT_FOUND',
        message: 'Search not found or already expired',
        retryable: false,
        requestId,
      });
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
    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    sendSearchError(res, 500, {
      code: 'SEARCH_RESUME_FAILED',
      message: error instanceof Error ? error.message : 'Search resume failed',
      retryable: true,
      requestId,
    });
  }
}
