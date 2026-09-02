export type LeadSourceMode = 'gmb' | 'linkedin' | 'ai';

export const defaultLeadSourceMode: LeadSourceMode = 'gmb';

export const leadSourceModeLabels: Record<LeadSourceMode, string> = {
  gmb: 'Google Business Profile',
  linkedin: 'LinkedIn',
  ai: 'AI mode',
};

export const leadSourceModeShortLabels: Record<LeadSourceMode, string> = {
  gmb: 'GMB',
  linkedin: 'LinkedIn',
  ai: 'AI',
};

export const normalizeLeadSourceMode = (value?: string | null): LeadSourceMode =>
  value === 'linkedin' || value === 'ai' ? value : defaultLeadSourceMode;
