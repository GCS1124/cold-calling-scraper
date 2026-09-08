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
  app.use(express.json());
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

  return app;
};
