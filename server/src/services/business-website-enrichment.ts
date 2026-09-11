import { createHash } from 'node:crypto';

import type { Lead, ReviewCandidate } from '../types/lead';
import type { ProviderWarning } from '../types/search';
import { isPhoneQualifiedLead } from './phone-requirement';

export type WebsiteLeadEnricher = (
  lead: Lead,
  options?: { deadlineMs?: number },
) => Promise<{ lead: Lead; warnings: ProviderWarning[] }>;

export type WebsiteEnrichmentResult = {
  leads: Lead[];
  reviewCandidates: ReviewCandidate[];
  warnings: ProviderWarning[];
  /** Domains selected after canonical-host de-duplication. */
  candidateCount: number;
  /** Individual crawl attempts actually started. */
  attemptedCount: number;
  completedCount: number;
  enrichedCount: number;
  blockedCount: number;
  timedOutCount: number;
  skippedCount: number;
  deferredCount: number;
  decisionMakerRecoveredCount: number;
};

const canonicalHost = (value: string | undefined) => {
  try {
    const url = new URL(value ?? '');
    return url.hostname.replace(/^www\./i, '').toLowerCase() || '';
  } catch {
    return '';
  }
};

const isBlockedFailure = (message: string) =>
  /captcha|cloudflare|access denied|forbidden|blocked|robots/i.test(message);

const isTimeoutFailure = (message: string) => /deadline|timed out|timeout|aborted/i.test(message);

const withDeadline = async <T>(promise: Promise<T>, deadlineMs: number, now: () => number) => {
  const remainingMs = Math.max(1, deadlineMs - now());
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Public website enrichment timed out.')), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const createWebsiteReviewCandidate = (
  lead: Lead,
  reason: 'website_timeout' | 'website_blocked' | 'deferred_by_budget',
  detail: string,
): ReviewCandidate => {
  const sourceUrls = [lead.website, lead.listingUrl, lead.contactSourceUrl]
    .filter((value): value is string => Boolean(value?.trim()));
  const stablePart = sourceUrls[0] || lead.id;

  return {
    id: `website-review-${createHash('sha1').update(`${stablePart}|${reason}`).digest('hex').slice(0, 20)}`,
    providerId: 'public-website-enrichment',
    providerName: 'Public Website Enrichment',
    reason,
    reasonDetail: detail,
    name: lead.name,
    personName: lead.decisionMakerName,
    organizationName: lead.organizationName ?? lead.name,
    originalRole: lead.originalRole,
    location: lead.address || lead.city,
    website: lead.website,
    profileUrl: lead.listingUrl,
    reportedPhone: lead.mobile || undefined,
    reportedEmail: lead.email || undefined,
    sourceUrls,
    evidence: 'A bounded public website enrichment pass did not complete; no access control was bypassed.',
    relatedLeadIds: [lead.id],
    discoveredAt: lead.scrapedAt || new Date().toISOString(),
  };
};

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
}): Promise<WebsiteEnrichmentResult> => {
  const eligible = leads.filter((lead) =>
    Boolean(lead.website?.trim()) &&
    (!isPhoneQualifiedLead(lead) || (includeDecisionMakerNames && !lead.decisionMakerName)) &&
    !lead.crawlAttempts,
  );
  const candidatesByHost = new Map<string, Lead>();
  let skippedCount = 0;

  for (const lead of eligible) {
    const host = canonicalHost(lead.website);
    if (!host || candidatesByHost.has(host)) {
      skippedCount += 1;
      continue;
    }
    candidatesByHost.set(host, lead);
  }

  const candidates = [...candidatesByHost.values()].slice(0, Math.max(0, maxCandidates));
  skippedCount += Math.max(0, candidatesByHost.size - candidates.length);
  const enrichedLeads: Lead[] = [];
  const reviewCandidates: ReviewCandidate[] = [];
  const warnings: ProviderWarning[] = [];
  let cursor = 0;
  let attemptedCount = 0;
  let completedCount = 0;
  let enrichedCount = 0;
  let blockedCount = 0;
  let timedOutCount = 0;
  let decisionMakerRecoveredCount = 0;

  const work = async () => {
    while (true) {
      if (now() >= deadlineMs) return;
      const candidate = candidates[cursor];
      cursor += 1;
      if (!candidate) return;
      attemptedCount += 1;

      try {
        const result = await withDeadline(enrichLead(candidate, { deadlineMs }), deadlineMs, now);
        completedCount += 1;
        enrichedLeads.push(result.lead);
        warnings.push(...result.warnings);

        const phoneRecovered = !isPhoneQualifiedLead(candidate) && isPhoneQualifiedLead(result.lead);
        const decisionMakerRecovered =
          includeDecisionMakerNames &&
          !candidate.decisionMakerName &&
          Boolean(result.lead.decisionMakerName);
        if (phoneRecovered || decisionMakerRecovered) enrichedCount += 1;
        if (decisionMakerRecovered) decisionMakerRecoveredCount += 1;
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : `${candidate.name}: public website enrichment failed`;
        const blocked = isBlockedFailure(message);
        const timedOut = !blocked && isTimeoutFailure(message);
        if (blocked) blockedCount += 1;
        if (timedOut) timedOutCount += 1;
        warnings.push({
          providerId: 'website-crawl',
          providerName: 'Website Crawl',
          message: `${candidate.name}: ${message}`,
          severity: timedOut ? 'info' : 'warning',
        });
        if (blocked || timedOut) {
          reviewCandidates.push(createWebsiteReviewCandidate(
            candidate,
            blocked ? 'website_blocked' : 'website_timeout',
            blocked
              ? 'The public website denied the bounded check; no login, CAPTCHA, or access-control bypass was attempted.'
              : 'The public website did not finish in the bounded enrichment window; the original public profile was preserved.',
          ));
        }
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), candidates.length);
  if (workerCount) {
    await Promise.all(Array.from({ length: workerCount }, () => work()));
  }

  const deferredCount = Math.max(0, candidates.length - attemptedCount);
  if (deferredCount) {
    for (const candidate of candidates.slice(attemptedCount)) {
      reviewCandidates.push(createWebsiteReviewCandidate(
        candidate,
        'deferred_by_budget',
        'This public website is queued for a later durable tick because the bounded enrichment window ended before it was started.',
      ));
    }
  }

  return {
    leads: enrichedLeads,
    reviewCandidates: [...new Map(reviewCandidates.map((candidate) => [candidate.id, candidate])).values()],
    warnings,
    candidateCount: candidates.length,
    attemptedCount,
    completedCount,
    enrichedCount,
    blockedCount,
    timedOutCount,
    skippedCount,
    deferredCount,
    decisionMakerRecoveredCount,
  };
};
