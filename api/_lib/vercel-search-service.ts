import type {
  SearchAccessContext,
  SearchRequest,
  SearchResponse,
  SearchStartContext,
} from '../../server/src/types/search.js';

type VercelSearchService = {
  startSearch: (
    request: SearchRequest,
    context?: SearchStartContext,
  ) => Promise<SearchResponse>;
  advanceSearch: (searchId: string) => Promise<SearchResponse | null>;
  cancelSearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  resumeSearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  reverifySearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
};

let servicePromise: Promise<VercelSearchService> | undefined;

export const getVercelSearchService = () => {
  servicePromise ??= import('../../server/src/services/vercel-search-service.js').then(
    ({ vercelSearchService }) => vercelSearchService,
  );

  return servicePromise;
};
