import type { SearchRequest, SearchResponse } from '../types/lead';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const fallbackApiBaseUrls = ['http://127.0.0.1:4000', 'http://localhost:4000'];

const getApiBases = () =>
  API_BASE_URL ? [API_BASE_URL] : ['', ...fallbackApiBaseUrls];

const parseError = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || 'Failed to fetch US lead results';
  } catch {
    return 'Failed to fetch US lead results';
  }
};

const fetchAcrossBases = async (
  path: string,
  init?: RequestInit,
): Promise<Response> => {
  let lastError: Error | null = null;

  for (const base of getApiBases()) {
    const url = `${base}${path}`;

    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        lastError = new Error(await parseError(response));
        continue;
      }

      return response;
    } catch (error) {
      if (error instanceof TypeError) {
        lastError = error;
        continue;
      }

      throw error;
    }
  }

  if (lastError instanceof TypeError) {
    throw new Error(
      'Lead Finder API is not reachable in dev. Start the app with `npm run dev` from the repo root.',
    );
  }

  throw lastError ?? new Error('Failed to fetch US lead results');
};

export type SearchApi = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse>;
};

export const searchApi: SearchApi = {
  async startSearch(request) {
    const response = await fetchAcrossBases('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    return response.json() as Promise<SearchResponse>;
  },

  async getSearch(searchId) {
    const response = await fetchAcrossBases(`/api/search/${searchId}`);
    return response.json() as Promise<SearchResponse>;
  },
};
