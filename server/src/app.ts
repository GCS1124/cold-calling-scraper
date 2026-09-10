import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { createSearchRouter, type SearchService } from './routes/search';
import type {
  SearchAccessContext,
  SearchFeedbackRequest,
  SearchStartContext,
} from './types/search';
import { buildIntegrationCapabilities } from '../../shared/integration-contract';
import {
  enforceIntegrationRateLimit,
} from './http/integration-rate-limit';
import { getRequestId, sendSearchError } from './http/search-http-contract';

type AppDeps = {
  search?: SearchService;
};

const createLazySearchService = (): SearchService => {
  let servicePromise: Promise<SearchService> | undefined;

  const getService = () => {
    servicePromise ??= import('./services/search-orchestrator').then(
      ({ searchService }) => searchService,
    );

    return servicePromise;
  };

  return {
    startSearch: async (request, context?: SearchStartContext) =>
      (await getService()).startSearch(request, context),
    getSearch: async (searchId, context?: SearchAccessContext) =>
      (await getService()).getSearch(searchId, context),
    cancelSearch: async (searchId, context?: SearchAccessContext) => {
      const service = await getService();
      return service.cancelSearch ? service.cancelSearch(searchId, context) : null;
    },
    resumeSearch: async (searchId, context?: SearchAccessContext) => {
      const service = await getService();
      return service.resumeSearch ? service.resumeSearch(searchId, context) : null;
    },
    reverifySearch: async (searchId, context?: SearchAccessContext) => {
      const service = await getService();
      return service.reverifySearch ? service.reverifySearch(searchId, context) : null;
    },
    recordFeedback: async (
      searchId: string,
      feedback: SearchFeedbackRequest,
      context?: SearchAccessContext,
    ) => {
      const service = await getService();
      return service.recordFeedback
        ? service.recordFeedback(searchId, feedback, context)
        : null;
    },
  };
};

export const createApp = (deps: AppDeps = {}) => {
  const app = express();

  const requireIntegrationOwner = (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    (req as Request & { requireAuthenticatedOwner?: boolean }).requireAuthenticatedOwner = true;
    next();
  };
  const enforceIntegrationTrafficProtection = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (await enforceIntegrationRateLimit(req, res)) next();
  };

  app.use(cors());
  // Search requests are small structured payloads. A hard parser limit keeps
  // malformed or oversized bodies from consuming the process before Zod can
  // apply field-level validation.
  app.use(express.json({ limit: '64kb' }));
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const search = deps.search ?? createLazySearchService();
  app.get('/api/v1/capabilities', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ ...buildIntegrationCapabilities(), requestId: 'local-capabilities' });
  });
  app.use('/api/search', createSearchRouter(search));
  app.use(
    '/api/v1/search',
    requireIntegrationOwner,
    enforceIntegrationTrafficProtection,
    createSearchRouter(search),
  );

  // Keep parser and unexpected middleware failures on the same versioned
  // error contract as route failures; Express' default HTML/stack response is
  // not safe for an API client or production logs.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    const requestId = getRequestId(req);
    const type = error && typeof error === 'object'
      ? (error as { type?: unknown }).type
      : undefined;

    if (type === 'entity.too.large') {
      sendSearchError(res, 413, {
        code: 'REQUEST_BODY_TOO_LARGE',
        message: 'Request body is too large.',
        retryable: false,
        requestId,
      });
      return;
    }

    if (type === 'entity.parse.failed') {
      sendSearchError(res, 400, {
        code: 'INVALID_JSON_BODY',
        message: 'Request body must be valid JSON.',
        retryable: false,
        requestId,
      });
      return;
    }

    console.error('[app] unhandled request error', {
      requestId,
      message: error instanceof Error ? error.message : 'Unknown request error',
    });
    sendSearchError(res, 500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Request could not be completed.',
      retryable: true,
      requestId,
    });
  });

  return app;
};
