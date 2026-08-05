export type LeadSourceMode = 'gmb' | 'linkedin';

export const defaultLeadSourceMode: LeadSourceMode = 'gmb';

export const leadSourceModeLabels: Record<LeadSourceMode, string> = {
  gmb: 'Google Business Profile',
  linkedin: 'LinkedIn',
};

export const leadSourceModeShortLabels: Record<LeadSourceMode, string> = {
  gmb: 'GMB',
  linkedin: 'LinkedIn',
};

export const normalizeLeadSourceMode = (value?: string | null): LeadSourceMode =>
  value === 'linkedin' ? 'linkedin' : defaultLeadSourceMode;
