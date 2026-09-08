import type { Lead, ResearchCandidate } from '../types/lead';
import type { SearchResponse } from '../types/search';
import type { LeadQualitySummary } from '../../../shared/lead-quality';
import { isPhoneQualifiedLead } from './phone-requirement';
import { rankQualifiedLeads } from './lead-quality';
import {
  buildSearchResponseContract,
  type PhonePolicyContract,
  type SearchExecutionContract,
  type SearchModeCode,
  type SEARCH_RESPONSE_CONTRACT_VERSION,
} from '../../../shared/search-contract';
import { buildLeadQualitySummary } from './quality-summary';
import { normalizeLeadSourceMode } from './search-source-mode';

export type ResearchDossier = {
  contractVersion: typeof SEARCH_RESPONSE_CONTRACT_VERSION;
  searchId: string;
  sourceMode: SearchModeCode;
  phonePolicy: PhonePolicyContract;
  execution?: SearchExecutionContract;
  requestId?: string;
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
  qualitySummary: LeadQualitySummary;
  leads: Lead[];
  /** AI-mode public research references are retained separately from qualified leads. */
  researchCandidates: ResearchCandidate[];
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
  const sourceMode = normalizeLeadSourceMode(response.meta.sourceMode);
  const contract = buildSearchResponseContract(sourceMode);

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
    qualitySummary: buildLeadQualitySummary(leads),
    leads,
    researchCandidates: response.researchCandidates ?? [],
  };
};
