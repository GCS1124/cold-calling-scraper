import type { SearchRequest, SearchResponse } from '../types/lead';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';
const minimumRequestedCount = 50;

const getApiBase = () => API_BASE_URL || '';

const normalizeRequest = (request: SearchRequest): SearchRequest => ({
  ...request,
  count: Math.max(request.count, minimumRequestedCount),
});

const parseError = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || 'Failed to fetch US lead results';
  } catch {
    return 'Failed to fetch US lead results';
  }
};

const fetchFromApi = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(`${getApiBase()}${path}`, init);
  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return response;
};

export type SearchApi = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse>;
};

export const searchApi: SearchApi = {
  async startSearch(request) {
    const normalized = normalizeRequest(request);
    const response = await fetchFromApi('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(normalized),
    });

    return response.json() as Promise<SearchResponse>;
  },

  async getSearch(searchId) {
    const response = await fetchFromApi(`/api/search/${searchId}`);
    return response.json() as Promise<SearchResponse>;
  },
};
