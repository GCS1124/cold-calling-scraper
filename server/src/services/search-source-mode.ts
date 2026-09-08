import type { SearchModeCode } from '../../../shared/search-contract';

export type LeadSourceMode = SearchModeCode;

export const defaultLeadSourceMode: LeadSourceMode = 'gmb';

export const leadSourceModeLabels: Record<LeadSourceMode, string> = {
  gmb: 'Google Business Profile',
  ai: 'AI mode',
};

export const leadSourceModeShortLabels: Record<LeadSourceMode, string> = {
  gmb: 'GMB',
  ai: 'AI',
};

export const normalizeLeadSourceMode = (value?: string | null): LeadSourceMode => {
  if (value === 'ai' || value === 'linkedin') {
    return 'ai';
  }

  return defaultLeadSourceMode;
};
