import { waitUntil } from '@vercel/functions';
import { getSearchJobSnapshot } from '../../server/src/services/search-job-snapshot.js';
import { getVercelSearchService } from '../_lib/vercel-search-service.js';
import {
  getRequestId,
  sendSearchError,
  setRequestIdHeader,
  withSearchRequestId,
} from '../../server/src/http/search-http-contract.js';
import { authorizeSearchRequest } from '../_lib/search-auth.js';

const activeSearchStatuses = new Set(['queued', 'discovering', 'enriching']);
const callbackStatuses = new Set(['pending', 'retrying']);

const isSearchPersistenceFailure = (error: unknown) =>
  error instanceof Error &&
  (error as Error & { code?: unknown }).code === 'SEARCH_PERSISTENCE_UNAVAILABLE';

export default async function handler(req: any, res: any) {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  if (req.method !== 'GET') {
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
    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    const auth = await authorizeSearchRequest(req, res, requestId);
    if (!auth) {
      return;
    }

    const response = auth.ownerId
      ? await getSearchJobSnapshot(searchId, { ownerId: auth.ownerId })
      : await getSearchJobSnapshot(searchId);
    if (!response) {
      res.status(204).end();
      return;
    }

    if (
      activeSearchStatuses.has(response.meta.status) ||
      callbackStatuses.has(response.meta.callback?.status ?? '')
    ) {
      waitUntil(
        getVercelSearchService()
          .then((service) => service.advanceSearch(searchId))
          .catch((error) => {
            console.error('[api/search/:id] background search failed', error);
          }),
      );
    }

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (isSearchPersistenceFailure(error)) {
      sendSearchError(res, 503, {
        code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Search persistence unavailable',
        retryable: false,
        requestId,
      });
      return;
    }

    sendSearchError(res, 500, {
      code: 'SEARCH_FAILED',
      message: error instanceof Error ? error.message : 'Search failed',
      retryable: true,
      requestId,
    });
  }
}
