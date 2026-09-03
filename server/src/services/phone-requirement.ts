import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';

export const isPhoneQualifiedLead = (lead: Lead) =>
  Boolean(
    lead.hasPhone &&
      lead.verifiedPhone &&
      lead.mobile?.trim() &&
      [
        lead.contactSourceUrl,
        lead.listingUrl,
        ...(lead.evidence ?? []).map((evidence) => evidence.sourceUrl),
      ].some((url) => {
        try {
          const parsed = new URL(url ?? '');
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      }),
  );

export const enforcePhoneRequirement = (leads: Lead[], request: SearchRequest) => {
  const phoneRequired = (request as unknown as { phoneRequired?: boolean }).phoneRequired;

  if (phoneRequired === false) {
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
