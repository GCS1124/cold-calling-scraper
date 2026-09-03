import { Router } from 'express';
import { ZodError } from 'zod';

import type { SearchRequest, SearchResponse } from '../types/search';
import { flattenSearchRequest, searchRequestSchema } from '../../../api/_lib/search-contract.js';
import { buildResearchDossier } from '../services/research-dossier';

export type SearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
  cancelSearch?: (searchId: string) => Promise<SearchResponse | null>;
  resumeSearch?: (searchId: string) => Promise<SearchResponse | null>;
  reverifySearch?: (searchId: string) => Promise<SearchResponse | null>;
};

type SearchResponder = {
  status: (code: number) => SearchResponder;
  json: (payload: unknown) => SearchResponder;
  end: () => SearchResponder;
};

export const handleStartSearch = async (
  search: SearchService,
  req: { body: unknown },
  res: SearchResponder,
) => {
  try {
    const payload = searchRequestSchema.parse(req.body);
    const response = await search.startSearch(flattenSearchRequest(payload));

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
      res.status(204).end();
      return;
    }

    res.status(200).json(response);
  } catch {
    res.status(500).json({
      error: 'Search failed',
    });
  }
};

export const handleCancelSearch = async (
  search: SearchService,
  req: { params: { searchId?: string } },
  res: SearchResponder,
) => {
  try {
    const searchId = req.params.searchId;
    if (!searchId) {
      res.status(400).json({ error: 'Missing search id' });
      return;
    }

    if (!search.cancelSearch) {
      res.status(501).json({ error: 'Search cancellation is not available' });
      return;
    }

    const response = await search.cancelSearch(searchId);
    if (!response) {
      res.status(404).json({ error: 'Search not found' });
      return;
    }

    res.status(200).json(response);
  } catch {
    res.status(500).json({ error: 'Unable to cancel search' });
  }
};

export const handleResumeSearch = async (
  search: SearchService,
  req: { params: { searchId?: string } },
  res: SearchResponder,
) => {
  try {
    const searchId = req.params.searchId;
    if (!searchId) {
      res.status(400).json({ error: 'Missing search id' });
      return;
    }

    if (!search.resumeSearch) {
      res.status(501).json({ error: 'Search resume is not available' });
      return;
    }

    const response = await search.resumeSearch(searchId);
    if (!response) {
      res.status(404).json({ error: 'Search not found' });
      return;
    }

    res.status(200).json(response);
  } catch {
    res.status(500).json({ error: 'Unable to resume search' });
  }
};

export const handleReverifySearch = async (
  search: SearchService,
  req: { params: { searchId?: string } },
  res: SearchResponder,
) => {
  try {
    const searchId = req.params.searchId;
    if (!searchId) {
      res.status(400).json({ error: 'Missing search id' });
      return;
    }

    if (!search.reverifySearch) {
      res.status(501).json({ error: 'Search reverification is not available' });
      return;
    }

    const response = await search.reverifySearch(searchId);
    if (!response) {
      res.status(404).json({ error: 'Search not found' });
      return;
    }

    res.status(200).json(response);
  } catch {
    res.status(500).json({ error: 'Unable to reverify search' });
  }
};

export const handleGetEvidence = async (
  search: SearchService,
  req: { params: { searchId?: string }; query?: { leadId?: string } },
  res: SearchResponder,
) => {
  try {
    const searchId = req.params.searchId;
    if (!searchId) {
      res.status(400).json({ error: 'Missing search id' });
      return;
    }

    const response = await search.getSearch(searchId);
    if (!response) {
      res.status(404).json({ error: 'Search not found' });
      return;
    }

    const dossier = buildResearchDossier(response, req.query?.leadId);
    if (req.query?.leadId && dossier.leads.length === 0) {
      res.status(404).json({ error: 'Lead not found in this search' });
      return;
    }

    res.status(200).json(dossier);
  } catch {
    res.status(500).json({ error: 'Unable to load research evidence' });
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
