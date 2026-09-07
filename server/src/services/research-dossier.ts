import type { Lead } from '../types/lead';
import type { SearchResponse } from '../types/search';
import { isPhoneQualifiedLead } from './phone-requirement';
import { rankQualifiedLeads } from './lead-quality';

export type ResearchDossier = {
  searchId: string;
  status: SearchResponse['meta']['status'];
  query: string;
  locationLabel: string;
  researchDepth: SearchResponse['meta']['researchDepth'];
  researchBrief?: string;
  generatedAt: string;
  limitations: string[];
  providerWarnings: SearchResponse['meta']['providerWarnings'];
  coverage: {
    requested: number;
    found: number;
    withPhone: number;
    withEmail: number;
    withWebsite: number;
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

  return {
    searchId: response.searchId,
    status: response.meta.status,
    query: response.meta.query,
    locationLabel: response.meta.locationLabel,
    researchDepth: response.meta.researchDepth ?? 'verified',
    ...(response.meta.researchBrief ? { researchBrief: response.meta.researchBrief } : {}),
    generatedAt: new Date().toISOString(),
    limitations: [...dossierLimitations],
    providerWarnings: response.meta.providerWarnings,
    coverage: {
      requested: response.meta.progress.requestedCount,
      found: leads.length,
      withPhone: leads.filter((lead) => lead.hasPhone).length,
      withEmail: leads.filter((lead) => lead.hasEmail).length,
      withWebsite: leads.filter((lead) => lead.hasWebsite).length,
    },
    leads,
  };
};
