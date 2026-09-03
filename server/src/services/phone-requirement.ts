import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';

export const isPhoneQualifiedLead = (lead: Lead) =>
  Boolean(lead.hasPhone && lead.verifiedPhone && lead.mobile?.trim());

export const enforcePhoneRequirement = (leads: Lead[], request: SearchRequest) => {
  if (request.phoneRequired !== true) {
    return {
      leads,
      excludedCount: 0,
      warning: undefined as ProviderWarning | undefined,
    };
  }

  const qualifiedLeads = leads.filter(isPhoneQualifiedLead);
  const excludedCount = leads.length - qualifiedLeads.length;

  return {
    leads: qualifiedLeads,
    excludedCount,
    warning:
      excludedCount > 0
        ? ({
            providerId: 'phone-required',
            providerName: 'Mobile requirement',
            message: `Excluded ${excludedCount} lead${excludedCount === 1 ? '' : 's'} without a validated publicly listed phone/mobile number because a mobile number is required.`,
            severity: 'info',
          } satisfies ProviderWarning)
        : undefined,
  };
};
