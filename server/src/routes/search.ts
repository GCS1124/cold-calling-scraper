import { Router } from 'express';
import { ZodError } from 'zod';

import type { SearchRequest, SearchResponse, SearchStartContext } from '../types/search';
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

export type SearchService = {
  startSearch: (
    request: SearchRequest,
    context?: SearchStartContext,
  ) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
  cancelSearch?: (searchId: string) => Promise<SearchResponse | null>;
  resumeSearch?: (searchId: string) => Promise<SearchResponse | null>;
  reverifySearch?: (searchId: string) => Promise<SearchResponse | null>;
};

type SearchResponder = {
  setHeader?: (name: string, value: string) => unknown;
  status: (code: number) => SearchResponder;
  json: (payload: unknown) => SearchResponder;
  end: () => SearchResponder;
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
    const response = idempotencyKey
      ? await search.startSearch(request, { idempotencyKey })
      : await search.startSearch(request);

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
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
  req: { params: { searchId?: string } },
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
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

    const response = await search.getSearch(searchId);
    if (!response) {
      res.status(204).end();
      return;
    }

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch {
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
  req: { params: { searchId?: string } },
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
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

    const response = await search.cancelSearch(searchId);
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
  } catch {
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
  req: { params: { searchId?: string } },
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
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

    const response = await search.resumeSearch(searchId);
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
  } catch {
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
  req: { params: { searchId?: string } },
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
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

    const response = await search.reverifySearch(searchId);
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
  } catch {
    sendSearchError(res, 500, {
      code: 'SEARCH_REVERIFY_FAILED',
      message: 'Unable to reverify search',
      retryable: true,
      requestId,
    });
  }
};

export const handleGetEvidence = async (
  search: SearchService,
  req: { params: { searchId?: string }; query?: { leadId?: string } },
  res: SearchResponder,
) => {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  try {
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

    const response = await search.getSearch(searchId);
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
  } catch {
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

  return router;
};
