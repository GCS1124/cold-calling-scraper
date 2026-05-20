import cors from 'cors';
import express from 'express';

import { createSearchRouter, type SearchService } from './routes/search';
import { searchService } from './services/search-orchestrator';

type AppDeps = {
  search?: SearchService;
};

export const createApp = (deps: AppDeps = {}) => {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api/search', createSearchRouter(deps.search ?? searchService));

  return app;
};
