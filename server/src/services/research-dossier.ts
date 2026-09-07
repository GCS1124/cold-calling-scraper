import type { Lead } from '../types/lead';
import type { SearchResponse } from '../types/search';
import { isPhoneQualifiedLead } from './phone-requirement';
import { rankQualifiedLeads } from './lead-quality';
import type { EvidenceSourceFamily } from '../../../shared/source-evidence';
import {
  buildSearchResponseContract,
  type PhonePolicyContract,
  type SearchExecutionContract,
  type SearchModeCode,
  type SEARCH_RESPONSE_CONTRACT_VERSION,
} from '../../../shared/search-contract';

type QualityTier = NonNullable<NonNullable<Lead['quality']>['tier']>;

export type ResearchDossier = {
  contractVersion: typeof SEARCH_RESPONSE_CONTRACT_VERSION;
  searchId: string;
  sourceMode: SearchModeCode;
  phonePolicy: PhonePolicyContract;
  execution?: SearchExecutionContract;
  status: SearchResponse['meta']['status'];
  query: string;
  locationLabel: string;
  researchDepth: SearchResponse['meta']['researchDepth'];
  researchBrief?: string;
  generatedAt: string;
  limitations: string[];
  providerWarnings: SearchResponse['meta']['providerWarnings'];
  providerCoverage: NonNullable<SearchResponse['meta']['progress']['providerCoverage']>;
  coverage: {
    observed: number;
    requested: number;
    found: number;
    excludedByPhone: number;
    withPhone: number;
    withEmail: number;
    withWebsite: number;
  };
  qualitySummary: {
    eligible: number;
    needsReview: number;
    freshPhoneObservations: number;
    tierCounts: Record<QualityTier, number>;
    sourceFamilyLeadCounts: Partial<Record<EvidenceSourceFamily, number>>;
  };
  leads: Lead[];
};

const dossierLimitations = [
  'Results are limited to public, legally accessible sources and published business contact details.',
  'LinkedIn data is public-search evidence only; private profiles, authenticated sessions, Premium data, and paywalls are not accessed.',
  'A missing phone or email means it was not publicly observed and does not prove the business has no such contact.',
  'Public phone observation does not establish mobile line type, personal ownership, reachability, or email delivery.',
];

export const buildResearchDossier = (
  response: SearchResponse,
  leadId?: string,
): ResearchDossier => {
  const leads = rankQualifiedLeads(response.leads.filter((lead) =>
    (!leadId || lead.id === leadId) && isPhoneQualifiedLead(lead)));
  const sourceMode = response.meta.sourceMode ?? 'gmb';
  const contract = buildSearchResponseContract(sourceMode);
  const tierCounts: Record<QualityTier, number> = {
    corroborated: 0,
    supported: 0,
    review: 0,
    excluded: 0,
  };
  const sourceFamilyLeadCounts: Partial<Record<EvidenceSourceFamily, number>> = {};

  for (const lead of leads) {
    const tier = lead.quality?.tier ?? 'review';
    tierCounts[tier] += 1;
    const sourceFamilies = new Set(
      lead.quality?.sourceFamilies ?? lead.scores?.sourceFamilies ?? [],
    );
    for (const sourceFamily of sourceFamilies) {
      sourceFamilyLeadCounts[sourceFamily] = (sourceFamilyLeadCounts[sourceFamily] ?? 0) + 1;
    }
  }

  const limitations = [...new Set([
    ...dossierLimitations,
    ...(response.meta.limitations ?? []),
  ])];

  return {
    contractVersion: contract.contractVersion,
    searchId: response.searchId,
    sourceMode,
    phonePolicy: contract.meta.phonePolicy,
    ...(response.meta.execution ? { execution: response.meta.execution } : {}),
    status: response.meta.status,
    query: response.meta.query,
    locationLabel: response.meta.locationLabel,
    researchDepth: response.meta.researchDepth ?? 'verified',
    ...(response.meta.researchBrief ? { researchBrief: response.meta.researchBrief } : {}),
    generatedAt: new Date().toISOString(),
    limitations,
    providerWarnings: response.meta.providerWarnings,
    providerCoverage: response.meta.progress.providerCoverage ?? [],
    coverage: {
      observed: response.leads.length,
      requested: response.meta.progress.requestedCount,
      found: leads.length,
      excludedByPhone: Math.max(0, response.leads.length - leads.length),
      withPhone: leads.filter((lead) => lead.hasPhone).length,
      withEmail: leads.filter((lead) => lead.hasEmail).length,
      withWebsite: leads.filter((lead) => lead.hasWebsite).length,
    },
    qualitySummary: {
      eligible: leads.length,
      needsReview: leads.filter((lead) => lead.quality?.tier === 'review').length,
      freshPhoneObservations: leads.filter((lead) => lead.quality?.freshness === 'recent').length,
      tierCounts,
      sourceFamilyLeadCounts,
    },
    leads,
  };
};
