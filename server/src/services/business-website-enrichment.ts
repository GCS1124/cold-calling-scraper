import type { Lead } from '../types/lead';
import type { ProviderWarning } from '../types/search';
import { isPhoneQualifiedLead } from './phone-requirement';

export type WebsiteLeadEnricher = (
  lead: Lead,
  options?: { deadlineMs?: number },
) => Promise<{ lead: Lead; warnings: ProviderWarning[] }>;

export const enrichWebsiteCandidates = async ({
  leads,
  enrichLead,
  deadlineMs,
  now = Date.now,
  maxCandidates = 12,
  concurrency = 3,
  includeDecisionMakerNames = false,
}: {
  leads: Lead[];
  enrichLead: WebsiteLeadEnricher;
  deadlineMs: number;
  maxCandidates?: number;
  concurrency?: number;
  includeDecisionMakerNames?: boolean;
  now?: () => number;
}) => {
  const candidates = leads
    .filter((lead) =>
      Boolean(lead.website?.trim()) &&
      (!isPhoneQualifiedLead(lead) || (includeDecisionMakerNames && !lead.decisionMakerName)) &&
      !lead.crawlAttempts,
    )
    .slice(0, maxCandidates);
  const enrichedLeads: Lead[] = [];
  const warnings: ProviderWarning[] = [];
  let cursor = 0;

  const work = async () => {
    while (cursor < candidates.length && now() < deadlineMs) {
      const candidate = candidates[cursor];
      cursor += 1;

      try {
        const result = await enrichLead(candidate, { deadlineMs });
        enrichedLeads.push(result.lead);
        warnings.push(...result.warnings);
      } catch (error) {
        warnings.push({
          providerId: 'website-crawl',
          providerName: 'Website Crawl',
          message:
            error instanceof Error
              ? `${candidate.name}: ${error.message}`
              : `${candidate.name}: public website enrichment failed`,
        });
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), candidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => work()));

  return {
    leads: enrichedLeads,
    warnings,
    attemptedCount: enrichedLeads.length,
    candidateCount: candidates.length,
  };
};
