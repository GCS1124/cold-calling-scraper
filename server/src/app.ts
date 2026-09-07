import cors from 'cors';
import express from 'express';

import { createSearchRouter, type SearchService } from './routes/search';
import type { SearchStartContext } from './types/search';

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
    getSearch: async (searchId) => (await getService()).getSearch(searchId),
    cancelSearch: async (searchId) => {
      const service = await getService();
      return service.cancelSearch ? service.cancelSearch(searchId) : null;
    },
    resumeSearch: async (searchId) => {
      const service = await getService();
      return service.resumeSearch ? service.resumeSearch(searchId) : null;
    },
    reverifySearch: async (searchId) => {
      const service = await getService();
      return service.reverifySearch ? service.reverifySearch(searchId) : null;
    },
  };
};

export const createApp = (deps: AppDeps = {}) => {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api/search', createSearchRouter(deps.search ?? createLazySearchService()));

  return app;
};
