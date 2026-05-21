import type { Lead } from '../types/lead';
import type { SearchRequest } from '../types/search';

export type LeadProviderRequest = {
  rawQuery: string;
  query: string;
  queryVariants?: string[];
  request: SearchRequest;
  deadlineMs?: number;
};

export type LeadProvider = {
  id: string;
  name: string;
  fetchLeads: (input: LeadProviderRequest) => Promise<Lead[]>;
};
