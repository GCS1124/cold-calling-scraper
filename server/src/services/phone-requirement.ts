import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';
import { getContactEvidence, normalizeContactPhone } from './contact-evidence';
import { rankQualifiedLeads } from './lead-quality';
import { prioritizeLeadsForRequest } from './notarycafe-search';

export const isPhoneQualifiedLead = (lead: Lead) =>
  Boolean(
    lead &&
      typeof lead === 'object' &&
      lead.hasPhone &&
      lead.verifiedPhone &&
      normalizeContactPhone(lead.mobile) &&
      getContactEvidence(lead, 'phone').length,
  );

export const enforcePhoneRequirement = (leads: Lead[], _request: SearchRequest) => {
  const safeLeads = Array.isArray(leads) ? leads : [];
  const qualifiedLeads = safeLeads.filter(isPhoneQualifiedLead);
  const excludedCount = safeLeads.length - qualifiedLeads.length;

  return {
    // The final qualification pass is shared by stateless, durable, and
    // feedback paths. Apply the source order here so later quality sorting
    // cannot move a returned NotaryCafe candidate behind a generic source.
    leads: prioritizeLeadsForRequest(rankQualifiedLeads(qualifiedLeads), _request),
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
