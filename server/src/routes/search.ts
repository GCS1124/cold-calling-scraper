import { Router } from 'express';
import { ZodError } from 'zod';

import type { SearchRequest, SearchResponse } from '../types/search';
import { searchRequestSchema } from '../types/search';

export type SearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
};

const minimumRequestedCount = 50;

const normalizeRequest = (request: SearchRequest): SearchRequest => ({
  ...request,
  count: Math.max(request.count, minimumRequestedCount),
});

type SearchResponder = {
  status: (code: number) => SearchResponder;
  json: (payload: unknown) => SearchResponder;
};

export const handleStartSearch = async (
  search: SearchService,
  req: { body: unknown },
  res: SearchResponder,
) => {
  try {
    const payload = searchRequestSchema.parse(req.body);
    const response = await search.startSearch(normalizeRequest(payload));

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Invalid search request',
        details: error.flatten(),
      });
      return;
    }

    res.status(500).json({
      error: 'Search failed',
    });
  }
};

export const handleGetSearch = async (
  search: SearchService,
  req: { params: { searchId?: string } },
  res: SearchResponder,
) => {
  try {
    const searchId = req.params.searchId;
    if (!searchId) {
      res.status(400).json({
        error: 'Missing search id',
      });
      return;
    }

    const response = await search.getSearch(searchId);
    if (!response) {
      res.status(404).json({
        error: 'Search not found',
      });
      return;
    }

    res.status(200).json(response);
  } catch {
    res.status(500).json({
      error: 'Search failed',
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

  return router;
};
