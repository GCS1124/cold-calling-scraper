import type { SearchAccessContext, SearchResponse } from '../types/search';
import {
  createSearchJobStore,
  toSearchResponse,
} from './search-job-store';
import { createLeadFeedbackStore } from './lead-feedback-store';

const store = createSearchJobStore();
const feedbackStore = createLeadFeedbackStore();

export const getSearchJobSnapshot = async (
  searchId: string,
  context?: SearchAccessContext,
): Promise<SearchResponse | null> => {
  await store.ensureSchema();

  const job = await store.get(searchId, context?.ownerId);
  if (!job) return null;

  const suppressionKeys = context?.ownerId
    ? await feedbackStore.getSuppressionKeys(context.ownerId)
    : new Set<string>();
  return toSearchResponse(job, suppressionKeys);
};
