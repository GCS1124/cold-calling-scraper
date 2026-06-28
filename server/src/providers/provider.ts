import type { Lead } from '../types/lead';
import type { SearchRequest } from '../types/search';
import type { NormalizedUsLocation } from '../services/us-location';

export type LeadProviderRequest = {
  rawQuery: string;
  query: string;
  queryVariants?: string[];
  request: SearchRequest;
  deadlineMs?: number;
  location?: NormalizedUsLocation;
};

export type LeadProvider = {
  id: string;
  name: string;
  fetchLeads: (input: LeadProviderRequest) => Promise<Lead[]>;
};
