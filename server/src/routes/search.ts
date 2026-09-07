import { Router } from 'express';
import { ZodError } from 'zod';

import type {
  SearchAccessContext,
  SearchFeedbackRequest,
  SearchRequest,
  SearchResponse,
  SearchStartContext,
} from '../types/search';
import { flattenSearchRequest, searchRequestSchema } from '../../../api/_lib/search-contract.js';
import { buildResearchDossier } from '../services/research-dossier';
import {
  getRequestId,
  sendSearchError,
  setRequestIdHeader,
  withSearchRequestId,
  getIdempotencyKey,
} from '../http/search-http-contract';
import { SearchIdempotencyConflictError } from '../services/search-idempotency';
import { isSearchPersistenceError } from '../services/search-job-store';
import { searchFeedbackSchema } from '../http/search-feedback-contract';
import {
  authenticateSearchRequest,
  isSearchAuthorizationError,
  type SearchAuthContext,
} from '../auth/search-auth';

export type SearchService = {
  startSearch: (
    request: SearchRequest,
    context?: SearchStartContext,
  ) => Promise<SearchResponse>;
  getSearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  cancelSearch?: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  resumeSearch?: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  reverifySearch?: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  recordFeedback?: (
    searchId: string,
    feedback: SearchFeedbackRequest,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
};

type SearchResponder = {
  setHeader?: (name: string, value: string) => unknown;
  status: (code: number) => SearchResponder;
  json: (payload: unknown) => SearchResponder;
  end: () => SearchResponder;
};

type SearchRouteRequest = {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  params: { searchId?: string };
  query?: { leadId?: string };
};

const getAccessContext = (auth: SearchAuthContext): SearchAccessContext | undefined =>
  auth.ownerId ? { ownerId: auth.ownerId } : undefined;

const sendAuthorizationError = (
  error: unknown,
  res: SearchResponder,
  requestId: string,
) => {
  if (!isSearchAuthorizationError(error)) {
    return false;
  }

  sendSearchError(res, error.status, {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    requestId,
  });
  return true;
};

export const handleStartSearch = async (
  search: SearchService,
  req: {
    body: unknown;
    headers?: Record<string, string | string[] | undefined>;
  },
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const auth = await authenticateSearchRequest(req);
    const idempotencyKey = getIdempotencyKey(req);
    if (idempotencyKey === null) {
      sendSearchError(res, 400, {
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Invalid Idempotency-Key header',
        retryable: false,
        requestId,
      });
      return;
    }

    const payload = searchRequestSchema.parse(req.body);
    const request = flattenSearchRequest(payload);
    const context: SearchStartContext = {
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(auth.ownerId ? { ownerId: auth.ownerId } : {}),
    };
    const response = Object.keys(context).length
      ? await search.startSearch(request, context)
      : await search.startSearch(request);

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (sendAuthorizationError(error, res, requestId)) {
      return;
    }

    if (error instanceof ZodError) {
      sendSearchError(res, 400, {
        code: 'INVALID_SEARCH_REQUEST',
        message: 'Invalid search request',
        retryable: false,
        requestId,
        details: error.flatten(),
      });
      return;
    }

    if (error instanceof SearchIdempotencyConflictError) {
      sendSearchError(res, 409, {
        code: error.code,
        message: error.message,
        retryable: false,
        requestId,
      });
      return;
    }

    sendSearchError(res, 500, {
      code: 'SEARCH_FAILED',
      message: 'Search failed',
      retryable: true,
      requestId,
    });
  }
};

export const handleGetSearch = async (
  search: SearchService,
  req: Pick<SearchRouteRequest, 'headers' | 'params'>,
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const auth = await authenticateSearchRequest(req);
    const searchId = req.params.searchId;
    if (!searchId) {
      sendSearchError(res, 400, {
        code: 'MISSING_SEARCH_ID',
        message: 'Missing search id',
        retryable: false,
        requestId,
      });
      return;
    }

    const access = getAccessContext(auth);
    const response = access
      ? await search.getSearch(searchId, access)
      : await search.getSearch(searchId);
    if (!response) {
      res.status(204).end();
      return;
    }

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (sendAuthorizationError(error, res, requestId)) {
      return;
    }

    sendSearchError(res, 500, {
      code: 'SEARCH_FAILED',
      message: 'Search failed',
      retryable: true,
      requestId,
    });
  }
};

export const handleCancelSearch = async (
  search: SearchService,
  req: Pick<SearchRouteRequest, 'headers' | 'params'>,
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const auth = await authenticateSearchRequest(req);
    const searchId = req.params.searchId;
    if (!searchId) {
      sendSearchError(res, 400, {
        code: 'MISSING_SEARCH_ID',
        message: 'Missing search id',
        retryable: false,
        requestId,
      });
      return;
    }

    if (!search.cancelSearch) {
      sendSearchError(res, 501, {
        code: 'SEARCH_CANCEL_UNAVAILABLE',
        message: 'Search cancellation is not available',
        retryable: false,
        requestId,
      });
      return;
    }

    const access = getAccessContext(auth);
    const response = access
      ? await search.cancelSearch(searchId, access)
      : await search.cancelSearch(searchId);
    if (!response) {
      sendSearchError(res, 404, {
        code: 'SEARCH_NOT_FOUND',
        message: 'Search not found',
        retryable: false,
        requestId,
      });
      return;
    }

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (sendAuthorizationError(error, res, requestId)) {
      return;
    }

    sendSearchError(res, 500, {
      code: 'SEARCH_CANCEL_FAILED',
      message: 'Unable to cancel search',
      retryable: true,
      requestId,
    });
  }
};

export const handleResumeSearch = async (
  search: SearchService,
  req: Pick<SearchRouteRequest, 'headers' | 'params'>,
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const auth = await authenticateSearchRequest(req);
    const searchId = req.params.searchId;
    if (!searchId) {
      sendSearchError(res, 400, {
        code: 'MISSING_SEARCH_ID',
        message: 'Missing search id',
        retryable: false,
        requestId,
      });
      return;
    }

    if (!search.resumeSearch) {
      sendSearchError(res, 501, {
        code: 'SEARCH_RESUME_UNAVAILABLE',
        message: 'Search resume is not available',
        retryable: false,
        requestId,
      });
      return;
    }

    const access = getAccessContext(auth);
    const response = access
      ? await search.resumeSearch(searchId, access)
      : await search.resumeSearch(searchId);
    if (!response) {
      sendSearchError(res, 404, {
        code: 'SEARCH_NOT_FOUND',
        message: 'Search not found',
        retryable: false,
        requestId,
      });
      return;
    }

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (sendAuthorizationError(error, res, requestId)) {
      return;
    }

    sendSearchError(res, 500, {
      code: 'SEARCH_RESUME_FAILED',
      message: 'Unable to resume search',
      retryable: true,
      requestId,
    });
  }
};

export const handleReverifySearch = async (
  search: SearchService,
  req: Pick<SearchRouteRequest, 'headers' | 'params'>,
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const auth = await authenticateSearchRequest(req);
    const searchId = req.params.searchId;
    if (!searchId) {
      sendSearchError(res, 400, {
        code: 'MISSING_SEARCH_ID',
        message: 'Missing search id',
        retryable: false,
        requestId,
      });
      return;
    }

    if (!search.reverifySearch) {
      sendSearchError(res, 501, {
        code: 'SEARCH_REVERIFY_UNAVAILABLE',
        message: 'Search reverification is not available',
        retryable: false,
        requestId,
      });
      return;
    }

    const access = getAccessContext(auth);
    const response = access
      ? await search.reverifySearch(searchId, access)
      : await search.reverifySearch(searchId);
    if (!response) {
      sendSearchError(res, 404, {
        code: 'SEARCH_NOT_FOUND',
        message: 'Search not found',
        retryable: false,
        requestId,
      });
      return;
    }

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (sendAuthorizationError(error, res, requestId)) {
      return;
    }

    sendSearchError(res, 500, {
      code: 'SEARCH_REVERIFY_FAILED',
      message: 'Unable to reverify search',
      retryable: true,
      requestId,
    });
  }
};

export const handleRecordFeedback = async (
  search: SearchService,
  req: Pick<SearchRouteRequest, 'headers' | 'params' | 'body'>,
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const auth = await authenticateSearchRequest(req);
    if (!auth.ownerId) {
      sendSearchError(res, 401, {
        code: 'FEEDBACK_AUTH_REQUIRED',
        message: 'Sign in to save lead feedback to your workspace.',
        retryable: false,
        requestId,
      });
      return;
    }

    const searchId = req.params.searchId;
    if (!searchId) {
      sendSearchError(res, 400, {
        code: 'MISSING_SEARCH_ID',
        message: 'Missing search id',
        retryable: false,
        requestId,
      });
      return;
    }

    if (!search.recordFeedback) {
      sendSearchError(res, 501, {
        code: 'FEEDBACK_UNAVAILABLE',
        message: 'Lead feedback is not available',
        retryable: false,
        requestId,
      });
      return;
    }

    const feedback = searchFeedbackSchema.parse(req.body);
    const response = await search.recordFeedback(searchId, feedback, {
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

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (sendAuthorizationError(error, res, requestId)) return;

    if (error instanceof ZodError) {
      sendSearchError(res, 400, {
        code: 'INVALID_FEEDBACK',
        message: 'Invalid lead feedback',
        retryable: false,
        requestId,
        details: error.flatten(),
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
};

export const handleGetEvidence = async (
  search: SearchService,
  req: Pick<SearchRouteRequest, 'headers' | 'params' | 'query'>,
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
    const auth = await authenticateSearchRequest(req);
    const searchId = req.params.searchId;
    if (!searchId) {
      sendSearchError(res, 400, {
        code: 'MISSING_SEARCH_ID',
        message: 'Missing search id',
        retryable: false,
        requestId,
      });
      return;
    }

    const access = getAccessContext(auth);
    const response = access
      ? await search.getSearch(searchId, access)
      : await search.getSearch(searchId);
    if (!response) {
      sendSearchError(res, 404, {
        code: 'SEARCH_NOT_FOUND',
        message: 'Search not found',
        retryable: false,
        requestId,
      });
      return;
    }

    const dossier = buildResearchDossier(response, req.query?.leadId);
    if (req.query?.leadId && dossier.leads.length === 0) {
      sendSearchError(res, 404, {
        code: 'LEAD_NOT_FOUND',
        message: 'Lead not found in this search',
        retryable: false,
        requestId,
      });
      return;
    }

    res.status(200).json({ ...dossier, requestId });
  } catch (error) {
    if (sendAuthorizationError(error, res, requestId)) {
      return;
    }

    sendSearchError(res, 500, {
      code: 'EVIDENCE_LOAD_FAILED',
      message: 'Unable to load research evidence',
      retryable: true,
      requestId,
    });
  }
};

export const createSearchRouter = (search: SearchService) => {
  const router = Router();

  router.post('/', (req, res) => {
    void handleStartSearch(search, req, res);
  });

  router.get('/:searchId', (req, res) => {
    void handleGetSearch(search, req, res);
  });

  router.get('/:searchId/evidence', (req, res) => {
    void handleGetEvidence(search, req, res);
  });

  router.post('/:searchId/cancel', (req, res) => {
    void handleCancelSearch(search, req, res);
  });

  router.post('/:searchId/resume', (req, res) => {
    void handleResumeSearch(search, req, res);
  });

  router.post('/:searchId/reverify', (req, res) => {
    void handleReverifySearch(search, req, res);
  });

  router.post('/:searchId/feedback', (req, res) => {
    void handleRecordFeedback(search, req, res);
  });

  return router;
};
