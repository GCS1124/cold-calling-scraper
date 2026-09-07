import type { SearchAccessContext, SearchResponse } from '../types/search';
import {
  createSearchJobStore,
  toSearchResponse,
} from './search-job-store';

const store = createSearchJobStore();

export const getSearchJobSnapshot = async (
  searchId: string,
  context?: SearchAccessContext,
): Promise<SearchResponse | null> => {
  await store.ensureSchema();

  const job = await store.get(searchId, context?.ownerId);
  return job ? toSearchResponse(job) : null;
};
