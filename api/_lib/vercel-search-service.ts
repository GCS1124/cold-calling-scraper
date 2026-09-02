import type { SearchRequest, SearchResponse } from '../../server/src/types/search.js';

type VercelSearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  advanceSearch: (searchId: string) => Promise<SearchResponse | null>;
};

let servicePromise: Promise<VercelSearchService> | undefined;

export const getVercelSearchService = () => {
  servicePromise ??= import('../../server/src/services/vercel-search-service.js').then(
    ({ vercelSearchService }) => vercelSearchService,
  );

  return servicePromise;
};
