import type { SearchRequest, SearchResponse } from '../types/lead';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';
const minimumRequestedCount = 50;
const genericSearchServiceError = 'Unable to reach the lead search service. Please try again.';
const localApiStartupTimeoutMs = 90_000;
const localApiRetryIntervalMs = 500;
const searchSnapshotRetryDelaysMs = [400, 900, 1_800] as const;
const searchSnapshotTimeoutMs = 15_000;
const isLocalDevelopment = import.meta.env.MODE === 'development';

export class SearchApiError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'SearchApiError';
    this.retryable = retryable;
  }
}

export const isRetryableSearchError = (error: unknown): error is SearchApiError =>
  error instanceof SearchApiError && error.retryable;

const getApiBase = () => API_BASE_URL || '';

const waitForLocalApi = async (fallbackMessage: string) => {
  if (!isLocalDevelopment) {
    return;
  }

  const deadline = Date.now() + localApiStartupTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${getApiBase()}/api/health`, {
        cache: 'no-store',
      });

      if (response.ok) {
        return;
      }
    } catch {
      // The local API may still be compiling its dependency graph.
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, localApiRetryIntervalMs);
    });
  }

  throw new Error(fallbackMessage);
};

const normalizeRequest = (request: SearchRequest): SearchRequest => ({
  ...request,
  count: Math.max(request.count, minimumRequestedCount),
});

const getSearchServiceError = (sourceMode?: SearchRequest['sourceMode']) =>
  sourceMode === 'linkedin'
    ? 'Unable to reach LinkedIn public-profile search. Please try again.'
    : genericSearchServiceError;

const isLegacyGenericError = (message: string) =>
  /^(?:Failed to fetch US lead results|Search failed)$/i.test(message.trim());

const parseError = async (response: Response, fallbackMessage: string) => {
  try {
    const payload = (await response.json()) as { error?: string };
    const message = payload.error?.trim();
    return message && !isLegacyGenericError(message) ? message : fallbackMessage;
  } catch {
    return fallbackMessage;
  }
};

const fetchFromApi = async (
  path: string,
  init?: RequestInit,
  fallbackMessage = genericSearchServiceError,
): Promise<Response> => {
  let response: Response;

  try {
    response = await fetch(`${getApiBase()}${path}`, init);
  } catch {
    throw new SearchApiError(fallbackMessage, false);
  }

  if (!response.ok) {
    throw new SearchApiError(await parseError(response, fallbackMessage), false);
  }

  return response;
};

const isRetryableSearchSnapshotStatus = (status: number) =>
  status === 502 || status === 503 || status === 504;

const wait = (delayMs: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });

const fetchSearchSnapshot = async (searchId: string) => {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= searchSnapshotRetryDelaysMs.length; attempt += 1) {
    let response: Response | undefined;

    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), searchSnapshotTimeoutMs);

      try {
        response = await fetch(`${getApiBase()}/api/search/${searchId}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeoutId);
      }
    } catch {
      lastError = new SearchApiError(genericSearchServiceError, true);
    }

    if (response) {
      if (response.ok) {
        return response;
      }

      if (!isRetryableSearchSnapshotStatus(response.status)) {
        throw new SearchApiError(
          await parseError(response, genericSearchServiceError),
          false,
        );
      }

      lastError = new SearchApiError(
        await parseError(response, 'The search service is temporarily unavailable.'),
        true,
      );
    }

    const delayMs = searchSnapshotRetryDelaysMs[attempt];
    if (delayMs === undefined) {
      break;
    }

    await wait(delayMs);
  }

  throw lastError ?? new SearchApiError(genericSearchServiceError, true);
};

export type SearchApi = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
};

export const searchApi: SearchApi = {
  async startSearch(request) {
    const normalized = normalizeRequest(request);
    await waitForLocalApi(getSearchServiceError(normalized.sourceMode));
    const response = await fetchFromApi(
      '/api/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(normalized),
      },
      getSearchServiceError(normalized.sourceMode),
    );

    return response.json() as Promise<SearchResponse>;
  },

  async getSearch(searchId) {
    const response = await fetchSearchSnapshot(searchId);

    if (response.status === 204) {
      return null;
    }

    return response.json() as Promise<SearchResponse>;
  },
};
