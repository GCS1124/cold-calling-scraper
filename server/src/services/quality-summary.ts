import type {
  LeadQualitySummary,
  LeadQualityTier,
} from '../../../shared/lead-quality';
import type { EvidenceSourceFamily } from '../../../shared/source-evidence';
import type { Lead } from '../types/lead';
import { isPhoneQualifiedLead } from './phone-requirement';
import { rankQualifiedLeads } from './lead-quality';

const emptyTierCounts = (): Record<LeadQualityTier, number> => ({
  corroborated: 0,
  supported: 0,
  review: 0,
  excluded: 0,
});

export const buildLeadQualitySummary = (leads: Lead[]): LeadQualitySummary => {
  const eligibleLeads = rankQualifiedLeads(leads.filter(isPhoneQualifiedLead));
  const tierCounts = emptyTierCounts();
  const sourceFamilyLeadCounts: Partial<Record<EvidenceSourceFamily, number>> = {};

  for (const lead of eligibleLeads) {
    const tier = lead.quality?.tier ?? 'review';
    tierCounts[tier] += 1;

    const sourceFamilies = new Set(
      lead.quality?.sourceFamilies ?? lead.scores?.sourceFamilies ?? [],
    );
    for (const sourceFamily of sourceFamilies) {
      sourceFamilyLeadCounts[sourceFamily] =
        (sourceFamilyLeadCounts[sourceFamily] ?? 0) + 1;
    }
  }

  return {
    eligible: eligibleLeads.length,
    needsReview: eligibleLeads.filter((lead) => lead.quality?.tier === 'review').length,
    freshPhoneObservations: eligibleLeads.filter(
      (lead) => lead.quality?.freshness === 'recent',
    ).length,
    tierCounts,
    sourceFamilyLeadCounts,
  };
};
