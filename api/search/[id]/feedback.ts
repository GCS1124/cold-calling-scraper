import { getRequestId, sendSearchError, setRequestIdHeader, withSearchRequestId } from '../../../server/src/http/search-http-contract.js';
import { searchFeedbackSchema } from '../../../server/src/http/search-feedback-contract.js';
import { isSearchPersistenceError } from '../../../server/src/services/search-job-store.js';
import { authorizeSearchRequest } from '../../_lib/search-auth.js';
import { getVercelSearchService } from '../../_lib/vercel-search-service.js';

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
    const auth = await authorizeSearchRequest(req, res, requestId);
    if (!auth) return;

    if (!auth.ownerId) {
      sendSearchError(res, 401, {
        code: 'FEEDBACK_AUTH_REQUIRED',
        message: 'Sign in to save lead feedback to your workspace.',
        retryable: false,
        requestId,
      });
      return;
    }

    const feedback = searchFeedbackSchema.parse(req.body);
    const service = await getVercelSearchService();
    const response = await service.recordFeedback(searchId, feedback, {
      ownerId: auth.ownerId,
    });
    if (!response) {
      sendSearchError(res, 404, {
        code: 'LEAD_NOT_FOUND',
        message: 'Lead not found in this workspace search',
        retryable: false,
        requestId,
      });
      return;
    }

    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      sendSearchError(res, 400, {
        code: 'INVALID_FEEDBACK',
        message: 'Invalid lead feedback',
        retryable: false,
        requestId,
      });
      return;
    }

    if (isSearchPersistenceError(error)) {
      sendSearchError(res, 503, {
        code: error.code,
        message: error.message,
        retryable: true,
        requestId,
      });
      return;
    }

    sendSearchError(res, 500, {
      code: 'FEEDBACK_FAILED',
      message: 'Unable to save lead feedback',
      retryable: true,
      requestId,
    });
  }
}
