import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';
import { getContactEvidence, normalizeContactPhone } from './contact-evidence';
import { rankQualifiedLeads } from './lead-quality';

export const isPhoneQualifiedLead = (lead: Lead) =>
  Boolean(
    lead.hasPhone &&
      lead.verifiedPhone &&
      normalizeContactPhone(lead.mobile) &&
      getContactEvidence(lead, 'phone').length,
  );

export const enforcePhoneRequirement = (leads: Lead[], _request: SearchRequest) => {
  const qualifiedLeads = leads.filter(isPhoneQualifiedLead);
  const excludedCount = leads.length - qualifiedLeads.length;

  return {
    leads: rankQualifiedLeads(qualifiedLeads),
    excludedCount,
    warning:
      excludedCount > 0
        ? ({
            providerId: 'phone-required',
            providerName: 'Public phone requirement',
            message: `Excluded ${excludedCount} lead${excludedCount === 1 ? '' : 's'} without a valid US phone and public source evidence. A public phone is required; mobile line type and reachability are not confirmed.`,
            severity: 'info',
          } satisfies ProviderWarning)
        : undefined,
  };
};
