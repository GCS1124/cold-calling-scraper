import type { Lead } from '../types/lead';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead } from './lead-validation';

/** Re-run deterministic normalization and scoring without refetching providers. */
export const reverifyLeads = (leads: Lead[]) =>
  deduplicateLeads(leads.map((lead) => enrichLead(lead)));
