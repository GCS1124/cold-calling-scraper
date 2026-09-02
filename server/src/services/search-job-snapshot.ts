import type { SearchResponse } from '../types/search';
import {
  createSearchJobStore,
  toSearchResponse,
} from './search-job-store';

const store = createSearchJobStore();

export const getSearchJobSnapshot = async (
  searchId: string,
): Promise<SearchResponse | null> => {
  await store.ensureSchema();

  const job = await store.get(searchId);
  return job ? toSearchResponse(job) : null;
};
