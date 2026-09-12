import { createHash, randomUUID } from 'node:crypto';

import type { Lead, ReviewCandidate } from '../types/lead';
import type {
  ProviderCoverage,
  ProviderWarning,
  SearchProgress,
  SearchRequest,
  SearchResponse,
  SearchAccessContext,
  SearchFeedbackRequest,
  SearchStartContext,
  SearchStatus,
} from '../types/search';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead } from './lead-validation';
import {
  discoverUsLeadsFromOsm,
  discoverUsLeadsFromOsmBatch,
  type OsmDiscoveryBatchResult,
} from './osm-discovery';
import { formatGoogleMapsFailure } from './google-maps-discovery';
import { enrichLeadFromWebsite } from './website-enrichment';
import {
  createWebsiteReviewCandidate,
  enrichWebsiteCandidates,
  planWebsiteEnrichment,
  type WebsiteLeadEnricher,
} from './business-website-enrichment';
import {
  discoverUsLeadsFromPublicDirectories,
  type PublicDirectoryDiscoveryResult,
} from './public-directory-discovery';
import {
  discoverUsLeadsFromAiMode,
  runGroundedGeminiPublicResearch,
  type AiDiscoveryResult,
  type GroundedGeminiPublicResearchResult,
} from './ai-lead-discovery';
import {
  googlePlacesProvider,
  isGooglePlacesConfigured,
} from '../providers/google-places';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';
import { filterLeadsForLocation } from './location-acceptance';
import { enforcePhoneRequirement, isPhoneQualifiedLead } from './phone-requirement';
import {
  createSearchJobStore,
  CURRENT_SCHEMA_VERSION,
  type SearchJobRecord,
  toSearchResponse,
} from './search-job-store';
import { mergeLinkedInWithPublicListingsWithDiagnostics } from './public-entity-matching';
import { resolveCategoryProfile } from './us-category-mapping';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { buildDiscoverySeeds } from './discovery-seeds';
import { getResearchDepthConfig } from './research-depth';
import { getLeadDiscoveryCandidateTarget } from './lead-discovery-budget';
import { prioritizeLeadsForRequest } from './notarycafe-search';
import { createResearchQueue, type ResearchQueue } from './research-queue';
import { reverifyLeads } from './research-reverification';
import { noUsableResultsWarning } from './search-finalization';
import { recordProviderCoverage } from './provider-coverage';
import {
  createSearchCallbackState,
  deliverSearchCompletionCallback,
  normalizeCallbackRequest,
  type CallbackFetch,
} from './search-completion-callback';
import {
  createSearchRequestFingerprint,
  normalizeIdempotencyKey,
} from './search-idempotency';
import { createLeadFeedbackStore, type LeadFeedbackStore } from './lead-feedback-store';
import {
  getLeadFeedbackEntityKey,
  getLeadFeedbackSuppressionKeys,
} from '../../../shared/lead-feedback';
import {
  leadSourceModeLabels,
  normalizeLeadSourceMode,
  type LeadSourceMode,
} from './search-source-mode';
import { isTestRuntime } from '../utils/runtime';

type VercelSearchService = {
  startSearch: (
    request: SearchRequest,
    context?: SearchStartContext,
  ) => Promise<SearchResponse>;
  getSearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  getSearchSnapshot: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  advanceSearch: (searchId: string, ownerId?: string) => Promise<SearchResponse | null>;
  cancelSearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  resumeSearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  reverifySearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
  recordFeedback: (
    searchId: string,
    feedback: SearchFeedbackRequest,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
};

type VercelSearchServiceDeps = {
  store?: ReturnType<typeof createSearchJobStore>;
  queue?: ResearchQueue;
  googlePlaces?: typeof googlePlacesProvider;
  normalizeLocation?: typeof normalizeUsLocation;
  discoverGoogleMapsLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    queryVariants: string[];
    maxResults?: number;
    queryLimit?: number;
    deadlineMs?: number;
  }) => Promise<Lead[]>;
  discoverAiLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    deadlineMs?: number;
    deferFinalization?: boolean;
    deferGemini?: boolean;
    publicListingBoxCursor?: number;
    publicListingMaxBoxes?: number;
  }) => Promise<AiDiscoveryResult>;
  runGeminiPublicResearch?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    listingLeads: Lead[];
    deadlineMs: number;
  }) => Promise<GroundedGeminiPublicResearchResult>;
  discoverOsmLeads?: (args: {
    request: { companyType: string; count: number };
    location: NormalizedUsLocation;
    profile: ReturnType<typeof resolveCategoryProfile>;
    deadlineMs?: number;
  }) => Promise<Lead[]>;
  discoverOsmLeadsBatch?: typeof discoverUsLeadsFromOsmBatch;
  discoverPublicDirectories?: typeof discoverUsLeadsFromPublicDirectories;
  enrichWebsiteLead?: WebsiteLeadEnricher;
  now?: () => number;
  idFactory?: () => string;
  feedbackStore?: LeadFeedbackStore;
  callbackFetch?: CallbackFetch;
  deliverCallback?: typeof deliverSearchCompletionCallback;
};

const discoverGoogleMapsLeadsOnDemand: NonNullable<
  VercelSearchServiceDeps['discoverGoogleMapsLeads']
> = async (args) => {
  // Keep Playwright and Chromium out of serverless cold starts.
  const { discoverUsLeadsFromGoogleMaps } = await import('./google-maps-discovery.js');
  return discoverUsLeadsFromGoogleMaps(args);
};

const jobTtlMs = 15 * 60 * 1000;
const maxCandidatePool = 3000;
const getDiscoveryStallMs = (requestedCount: number) =>
  requestedCount >= 50 ? 45_000 : 20_000;
const getDiscoveryStallLabel = (requestedCount: number) =>
  requestedCount >= 50 ? '45 seconds' : '20 seconds';

const getDiscoveryBatchSize = (requestedCount: number) => (requestedCount >= 100 ? 2 : 1);
const getPerSeedCount = (requestedCount: number) =>
  requestedCount >= 100 ? 30 : requestedCount >= 50 ? 25 : 20;
const getGooglePlacesTimeoutMs = (requestedCount: number) =>
  requestedCount >= 100 ? 32_000 : requestedCount >= 50 ? 20_000 : 8_000;
const getGoogleMapsTimeoutMs = (requestedCount: number) =>
  requestedCount >= 50 ? 8_000 : 5_000;
const getAiDiscoveryWindowMs = (requestedCount: number) =>
  requestedCount >= 50 ? 36_000 : 30_000;
const aiLogicalBudgetMs = 90_000;
const aiOsmContinuationTickWindowMs = 15_000;
const aiGeminiTickWindowMs = 20_000;
const aiWebsiteTickWindowMs = 36_000;
const maxAiOsmBoxesPerTick = 4;
const maxAiOsmContinuationPasses = 1;
const maxDurableWebsiteHosts = 120;
const durableWebsiteBatchSize = 12;
const getMaxTickDurationMs = (requestedCount: number) =>
  requestedCount >= 50 ? 45_000 : 30_000;
const publicDirectoryDiscoveryTimeoutMs = 10_000;
const processingLeaseMs = 70_000;

const isVercelRuntime = () =>
  process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);

const withNow = () => Date.now();

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string) => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const isTimeoutFailure = (error: unknown) =>
  error instanceof Error && /deadline|timed out|timeout|aborted/i.test(error.message);

const isBlockedFailure = (error: unknown) =>
  error instanceof Error && /captcha|cloudflare|access challenge|access denied|forbidden|blocked|robots/i.test(error.message);

const isRateLimitedFailure = (error: unknown) =>
  error instanceof Error && /429|rate.?limit|too many requests|quota/i.test(error.message);

const createSourceReviewCandidate = (
  lead: Lead,
  providerId: string,
  providerName: string,
  reason: ReviewCandidate['reason'],
  reasonDetail: string,
): ReviewCandidate => {
  const sourceUrls = [
    lead.listingUrl,
    lead.contactSourceUrl,
    lead.decisionMakerSourceUrl,
    lead.website,
  ].filter((value): value is string => Boolean(value?.trim()));
  const stablePart = sourceUrls[0] ?? `${lead.name}|${lead.city}|${lead.mobile ?? ''}`;

  return {
    id: `${providerId}-review-${createHash('sha1').update(`${stablePart}|${reason}`).digest('hex').slice(0, 20)}`,
    providerId,
    providerName,
    reason,
    reasonDetail,
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
    evidence: lead.publicEvidence?.profileSnippet || lead.evidence?.[0]?.claim,
    relatedLeadIds: [lead.id],
    discoveredAt: lead.scrapedAt || new Date().toISOString(),
  };
};

const createProgress = (requestedCount: number): SearchProgress => ({
  discovered: 0,
  enriched: 0,
  publicContactsFound: 0,
  phoneExcludedCount: 0,
  totalCandidates: 0,
  requestedCount,
  foundCount: 0,
  duplicatesRemoved: 0,
  currentSource: 'Queued',
  batchesCompleted: 0,
  estimatedRemaining: requestedCount,
});

const normalizeLead = (lead: Lead) => enrichLead(lead);

const rankDiscoveryCandidates = (leads: Lead[]) =>
  [...leads].sort((left, right) => {
    const leftSignal =
      Number(left.source.includes('Google Places')) * 8 +
      Number(left.source.includes('LinkedIn')) * 4 +
      Number(left.hasWebsite) * 5 +
      Number(left.hasPhone) * 5 +
      Number(Boolean(left.address)) * 2 +
      Number(Boolean(left.website && left.mobile)) * 4 +
      (left.sourceScore ?? 0) / 20;
    const rightSignal =
      Number(right.source.includes('Google Places')) * 8 +
      Number(right.source.includes('LinkedIn')) * 4 +
      Number(right.hasWebsite) * 5 +
      Number(right.hasPhone) * 5 +
      Number(Boolean(right.address)) * 2 +
      Number(Boolean(right.website && right.mobile)) * 4 +
      (right.sourceScore ?? 0) / 20;

    return rightSignal - leftSignal || right.confidence - left.confidence || left.name.localeCompare(right.name);
  });

const refreshProgress = (job: SearchJobRecord) => {
  job.progress.discovered = job.leads.length;
  job.progress.totalCandidates = job.leads.length;
  job.progress.foundCount = Math.min(job.leads.length, job.request.count);
  job.progress.publicContactsFound = job.leads.filter(
    (lead) => lead.hasEmail || lead.hasPhone,
  ).length;
  job.progress.estimatedRemaining = Math.max(0, job.request.count - job.leads.length);
};

const hasRequestedPhoneCandidates = (job: SearchJobRecord) =>
  job.leads.filter(isPhoneQualifiedLead).length >= job.request.count;

const hasWebsiteDecisionMakerCandidates = (job: SearchJobRecord) =>
  job.leads.some((lead) =>
    Boolean(lead.website?.trim()) &&
    !lead.decisionMakerName &&
    !lead.crawlAttempts,
  );

const getLastProgressAt = (job: SearchJobRecord) => job.lastProgressAt ?? job.createdAt;

const appendWarningOnce = (job: SearchJobRecord, warning: ProviderWarning) => {
  if (
    job.providerWarnings.some(
      (item) => item.providerId === warning.providerId && item.message === warning.message,
    )
  ) {
    return;
  }

  job.providerWarnings.push(warning);
};

const dedupeWithCount = (leads: Lead[]) => {
  const deduped = deduplicateLeads(leads);
  return {
    leads: deduped,
    duplicatesRemoved: Math.max(0, leads.length - deduped.length),
  };
};

const trimCandidatePool = (leads: Lead[], request: SearchRequest) =>
  prioritizeLeadsForRequest(
    rankDiscoveryCandidates(leads),
    request,
  ).slice(0, Math.min(maxCandidatePool, request.count * 5));

const finalizeLeads = (job: SearchJobRecord) => {
  const phoneRequirement = enforcePhoneRequirement(job.leads, job.request);
  job.progress.phoneExcludedCount = phoneRequirement.excludedCount;
  if (phoneRequirement.warning) {
    appendWarningOnce(job, phoneRequirement.warning);
  }
  job.leads = phoneRequirement.leads.slice(0, job.request.count);
  refreshProgress(job);
};

const finalizeJobStatus = (job: SearchJobRecord) => {
  finalizeLeads(job);

  if (!job.leads.length) {
    appendWarningOnce(job, noUsableResultsWarning());
    job.status = 'failed';
    job.progress.currentSource = 'Failed';
  } else {
    job.status = 'complete';
    job.progress.currentSource = 'Complete';
  }

  refreshProgress(job);
};

const mergeLeads = (
  job: SearchJobRecord,
  incoming: Lead[],
  now: () => number,
  countDuplicates = true,
) => {
  const previousCount = job.leads.length;
  const merged = [...job.leads, ...incoming.map(normalizeLead)];
  const { leads, duplicatesRemoved } = dedupeWithCount(merged);
  if (countDuplicates) {
    job.progress.duplicatesRemoved += duplicatesRemoved;
  }
  job.leads = trimCandidatePool(leads, job.request);
  if (job.leads.length > previousCount) {
    job.lastProgressAt = now();
  }
  refreshProgress(job);
};

const runAiDiscovery = async (
  job: SearchJobRecord,
  request: SearchRequest,
  location: NormalizedUsLocation,
  discoverAiLeads: NonNullable<VercelSearchServiceDeps['discoverAiLeads']>,
  now: () => number,
  deadlineMs = now() + getAiDiscoveryWindowMs(request.count),
  publicListingBoxCursor = 0,
  publicListingMaxBoxes = maxAiOsmBoxesPerTick,
) => {
  job.progress.currentSource = leadSourceModeLabels.ai;

  const result = await discoverAiLeads({
    request,
    location,
    deadlineMs,
    deferFinalization: true,
    deferGemini: true,
    publicListingBoxCursor,
    publicListingMaxBoxes,
  });

  for (const warning of result.warnings) {
    appendWarningOnce(job, warning);
  }

  recordProviderCoverage(job.progress, result.coverage);
  job.progress.aiAssistance = result.aiAssistance;
  job.progress.enriched = result.enrichedCount;
  if (result.publicCoverage) {
    job.progress.publicQueriesAttempted = result.publicCoverage.queriesAttempted;
    job.progress.publicProvidersChecked = result.publicCoverage.providersChecked;
    job.progress.publicQueryFamilies = result.publicCoverage.queryFamilies;
    job.progress.publicQueryFamilyCounts = result.publicCoverage.queryFamilyCounts;
  }

  mergeLeads(job, result.leads, now);
  if (result.researchCandidates?.length) {
    job.researchCandidates = [
      ...(job.researchCandidates ?? []),
      ...result.researchCandidates,
    ];
  }
  if (result.reviewCandidates?.length) {
    job.reviewCandidates = [...new Map([
      ...(job.reviewCandidates ?? []),
      ...result.reviewCandidates,
    ].map((candidate) => [candidate.id, candidate] as const)).values()];
  }
  job.progress.batchesCompleted += 1;
  return result;
};

const mergeReviewCandidates = (
  current: ReviewCandidate[] | undefined,
  incoming: ReviewCandidate[] | undefined,
) => [...new Map([
  ...(current ?? []),
  ...(incoming ?? []),
].map((candidate) => [candidate.id, candidate] as const)).values()].slice(0, 200);

const runAiGroundedGeminiResearch = async (
  job: SearchJobRecord,
  location: NormalizedUsLocation,
  runGeminiPublicResearch: NonNullable<VercelSearchServiceDeps['runGeminiPublicResearch']>,
  now: () => number,
  deadlineMs: number,
) => {
  job.progress.currentSource = 'Gemini public discovery';
  const result = await runGeminiPublicResearch({
    request: job.request,
    location,
    listingLeads: job.leads,
    deadlineMs,
  });
  for (const warning of result.warnings) appendWarningOnce(job, warning);
  recordProviderCoverage(job.progress, result.coverage);
  job.progress.aiAssistance = result.aiAssistance;
  mergeLeads(job, result.leads, now);
  if (result.researchCandidates.length) {
    job.researchCandidates = [...new Map([
      ...(job.researchCandidates ?? []),
      ...result.researchCandidates,
    ].map((candidate) => [candidate.id, candidate] as const)).values()].slice(0, 200);
  }
  if (result.reviewCandidates.length) {
    job.reviewCandidates = mergeReviewCandidates(job.reviewCandidates, result.reviewCandidates);
  }
  job.progress.batchesCompleted += 1;
  return result;
};

/**
 * Continue only the persisted OSM spatial slice. This deliberately does not
 * re-run LinkedIn, NotaryCafe, directories, or Gemini, which keeps retries
 * bounded and guarantees one grounded Gemini pass per logical search.
 */
const runAiPublicListingContinuation = async (
  job: SearchJobRecord,
  location: NormalizedUsLocation,
  discoverOsmBatch: typeof discoverUsLeadsFromOsmBatch,
  now: () => number,
  deadlineMs: number,
  boxCursor: number,
) => {
  job.progress.currentSource = 'Public business listings';
  const batch = await discoverOsmBatch({
    request: {
      companyType: job.request.companyType,
      count: job.request.count,
    },
    location,
    profile: resolveCategoryProfile(job.request.companyType),
    deadlineMs,
    boxCursor,
    maxBoxes: maxAiOsmBoxesPerTick,
  });

  const observed = deduplicateLeads(batch.leads.flatMap((lead) => {
    try {
      return [normalizeLead(lead)];
    } catch {
      return [];
    }
  }));
  const locationScoped = filterLeadsForLocation(observed, location);
  const scopedIds = new Set(locationScoped.map((lead) => lead.id));
  const reviewCandidates = observed.flatMap((lead) => {
    if (!scopedIds.has(lead.id)) {
      return [createSourceReviewCandidate(
        lead,
        'public-business-listings',
        'Public Business Listings',
        'location_mismatch',
        `The public listing did not deterministically match ${location.label}, so it was not promoted.`,
      )];
    }
    if (!isPhoneQualifiedLead(lead)) {
      return [createSourceReviewCandidate(
        lead,
        'public-business-listings',
        'Public Business Listings',
        lead.mobile ? 'invalid_public_phone' : 'missing_public_phone',
        lead.mobile
          ? 'The public listing did not provide a validated US phone with public source evidence.'
          : 'The public listing did not expose a validated public US phone route.',
      )];
    }
    return [];
  });
  const acceptedCount = locationScoped.filter(isPhoneQualifiedLead).length;
  const deferredCount = batch.completed
    ? 0
    : Math.max(0, batch.totalBoxCount - batch.nextBoxCursor);
  const failedOnly = Boolean(batch.failedBoxCount && !batch.completedBoxCount);
  const outcome: NonNullable<ProviderCoverage['outcome']> = batch.timedOut
    ? 'timed_out'
    : failedOnly
      ? 'failed'
      : !batch.completed
        ? 'deferred'
        : observed.length
          ? 'returned'
          : 'empty';

  if (batch.errorMessage) {
    appendWarningOnce(job, {
      providerId: 'public-business-listings',
      providerName: 'Public Business Listings',
      message: `${batch.errorMessage} Remaining public listing boxes were retained for bounded continuation.`,
      severity: batch.timedOut ? 'info' : 'warning',
    });
  }
  recordProviderCoverage(job.progress, [{
    providerId: 'public-business-listings',
    providerName: 'Public Business Listings',
    status: outcome === 'failed' ? 'failed' : outcome === 'timed_out' ? 'partial' : batch.completed ? 'returned' : 'configured',
    phase: outcome === 'failed' || outcome === 'timed_out' ? 'degraded' : batch.completed ? 'completed' : 'queued',
    outcome,
    leadCount: acceptedCount,
    attemptedCount: batch.attemptedBoxCount,
    observedCount: observed.length,
    acceptedCount,
    reviewCount: reviewCandidates.length,
    deferredCount,
    updatedAt: new Date(now()).toISOString(),
    message: batch.completed
      ? `OpenStreetMap continuation completed ${batch.completedBoxCount}/${batch.totalBoxCount} spatial boxes; ${observed.length} public candidate${observed.length === 1 ? '' : 's'} observed.`
      : `OpenStreetMap continuation advanced to box ${batch.nextBoxCursor}/${batch.totalBoxCount}; ${deferredCount} spatial box${deferredCount === 1 ? '' : 'es'} remain deferred.`,
  }]);
  mergeLeads(job, locationScoped, now);
  job.reviewCandidates = mergeReviewCandidates(job.reviewCandidates, reviewCandidates);
  job.progress.batchesCompleted += 1;

  return batch;
};

const isPublicLinkedInLead = (lead: Lead) => /\blink(?:ed\s*-?in)\b|linkedin\.com\/(?:in|pub)\//i.test(
  [
    lead.source,
    lead.listingUrl,
    lead.contactSourceUrl,
    lead.decisionMakerSourceUrl,
    ...(lead.publicEvidence?.sources?.map((source) => source.providerName) ?? []),
  ].filter(Boolean).join(' '),
);

const isGoogleBusinessLead = (lead: Lead) => /\b(?:google\s*(?:places|business|maps)|gmb)\b|(?:google\.[^/]+\/maps|maps\.google\.)/i.test(
  [lead.source, lead.listingUrl, lead.contactSourceUrl].filter(Boolean).join(' '),
);

const runAiWebsiteEnrichment = async (
  job: SearchJobRecord,
  enrichWebsiteLead: WebsiteLeadEnricher | undefined,
  now: () => number,
  deadlineMs: number,
  workflow: NonNullable<SearchJobRecord['aiWorkflow']>,
) => {
  job.progress.currentSource = 'Public website enrichment';
  if (!enrichWebsiteLead) {
    recordProviderCoverage(job.progress, [{
      providerId: 'public-website-enrichment',
      providerName: 'Public Website Enrichment',
      status: 'not_configured',
      phase: 'skipped',
      outcome: 'not_configured',
      leadCount: 0,
      attemptedCount: 0,
      observedCount: 0,
      acceptedCount: 0,
      reviewCount: 0,
      deferredCount: 0,
      updatedAt: new Date(now()).toISOString(),
      message: 'Public website enrichment is not configured for this durable execution path.',
    }]);
    return undefined;
  }

  const leadById = new Map(job.leads.map((lead) => [lead.id, lead] as const));
  if (workflow.websiteQueue === undefined) {
    const plan = planWebsiteEnrichment({
      leads: job.leads,
      includeDecisionMakerNames: true,
    });
    const queue = plan.candidateLeadIds.slice(0, maxDurableWebsiteHosts);
    workflow.websiteQueue = queue;
    workflow.websiteTotalHosts = queue.length;
    workflow.websiteSkippedCount = plan.skippedCount + Math.max(
      0,
      plan.candidateLeadIds.length - queue.length,
    );
    workflow.websiteObservedReported = false;
  }

  const persistedQueue = workflow.websiteQueue.filter((leadId) => leadById.has(leadId));
  const missingQueuedLeads = workflow.websiteQueue.length - persistedQueue.length;
  if (missingQueuedLeads) {
    workflow.websiteSkippedCount = (workflow.websiteSkippedCount ?? 0) + missingQueuedLeads;
  }
  workflow.websiteQueue = persistedQueue;
  const batchIds = persistedQueue.slice(0, durableWebsiteBatchSize);
  const batchLeads = batchIds.flatMap((leadId) => {
    const lead = leadById.get(leadId);
    return lead ? [lead] : [];
  });
  const result = await enrichWebsiteCandidates({
    leads: batchLeads,
    enrichLead: enrichWebsiteLead,
    deadlineMs,
    maxCandidates: durableWebsiteBatchSize,
    includeDecisionMakerNames: true,
    now,
  });
  for (const warning of result.warnings) appendWarningOnce(job, warning);
  const deferredIds = new Set(result.deferredLeadIds);
  workflow.websiteQueue = [
    ...batchIds.filter((leadId) => deferredIds.has(leadId)),
    ...persistedQueue.slice(batchIds.length),
  ];

  // Deferred review candidates are a live queue view. Replace them on every
  // tick so records that have since been attempted never look permanently
  // deferred, while real timeout/block candidates remain reviewable.
  const retainedReviews = (job.reviewCandidates ?? []).filter((candidate) => !(
    candidate.providerId === 'public-website-enrichment' &&
    candidate.reason === 'deferred_by_budget'
  ));
  const completedReviews = result.reviewCandidates.filter(
    (candidate) => candidate.reason !== 'deferred_by_budget',
  );
  const remainingReviews = workflow.websiteQueue.flatMap((leadId) => {
    const lead = leadById.get(leadId);
    return lead
      ? [createWebsiteReviewCandidate(
          lead,
          'deferred_by_budget',
          'This public website remains queued for a later bounded durable tick; the source profile is preserved and is not exportable until the normal evidence gate passes.',
        )]
      : [];
  });
  job.reviewCandidates = mergeReviewCandidates(retainedReviews, [
    ...completedReviews,
    ...remainingReviews,
  ]);
  const remainingCount = workflow.websiteQueue.length;
  const totalHosts = workflow.websiteTotalHosts ?? 0;
  const isFirstWebsiteSnapshot = !workflow.websiteObservedReported;
  const observedCount = isFirstWebsiteSnapshot ? totalHosts : 0;
  // The initial snapshot reports all hosts that are outside the canonical
  // queue. If a persisted id disappears from the lead pool later, report that
  // newly skipped work in that later tick too instead of silently losing it.
  const skippedCount = isFirstWebsiteSnapshot
    ? workflow.websiteSkippedCount ?? 0
    : missingQueuedLeads;
  workflow.websiteObservedReported = true;
  const reviewCount = (job.reviewCandidates ?? []).filter(
    (candidate) => candidate.providerId === 'public-website-enrichment',
  ).length;
  const outcome: NonNullable<ProviderCoverage['outcome']> = remainingCount
    ? 'deferred'
    : result.blockedCount
      ? 'blocked'
      : result.timedOutCount
        ? 'timed_out'
        : result.enrichedCount
          ? 'returned'
          : 'empty';
  recordProviderCoverage(job.progress, [{
    providerId: 'public-website-enrichment',
    providerName: 'Public Website Enrichment',
    status: remainingCount
      ? 'configured'
      : result.blockedCount || result.timedOutCount
        ? 'partial'
        : 'returned',
    phase: remainingCount
      ? 'queued'
      : result.blockedCount || result.timedOutCount
        ? 'degraded'
        : 'completed',
    outcome,
    leadCount: result.enrichedCount,
    attemptedCount: result.attemptedCount,
    observedCount,
    acceptedCount: result.enrichedCount,
    reviewCount,
    deferredCount: remainingCount,
    completedCount: result.completedCount,
    enrichedCount: result.enrichedCount,
    blockedCount: result.blockedCount,
    timedOutCount: result.timedOutCount,
    skippedCount,
    decisionMakerRecoveredCount: result.decisionMakerRecoveredCount,
    updatedAt: new Date(now()).toISOString(),
    message: remainingCount
      ? `Website enrichment processed ${result.attemptedCount} bounded public domain${result.attemptedCount === 1 ? '' : 's'} this tick; ${remainingCount}/${totalHosts} canonical host${remainingCount === 1 ? '' : 's'} remain queued. ${result.blockedCount} blocked and ${result.timedOutCount} timed out attempt${result.blockedCount + result.timedOutCount === 1 ? '' : 's'} remain in review.`
      : `Website enrichment completed ${totalHosts} canonical public host${totalHosts === 1 ? '' : 's'} across durable ticks: ${result.attemptedCount} attempted this tick, ${result.completedCount} completed, ${result.enrichedCount} enriched, ${result.blockedCount} blocked, ${result.timedOutCount} timed out, and ${result.decisionMakerRecoveredCount} public decision-maker name${result.decisionMakerRecoveredCount === 1 ? '' : 's'} recovered.`,
  }]);
  if (result.leads.length) {
    mergeLeads(job, result.leads, now, false);
    job.progress.enriched += result.enrichedCount;
  }
  return { ...result, deferredCount: remainingCount };
};

const runAiFinalFusion = (job: SearchJobRecord, now: () => number) => {
  job.progress.currentSource = 'Final LinkedIn + Google Business fusion';
  const linkedInLeads = job.leads.filter(isPublicLinkedInLead);
  const googleBusinessLeads = job.leads.filter(isGoogleBusinessLead);
  const fusion = mergeLinkedInWithPublicListingsWithDiagnostics(linkedInLeads, googleBusinessLeads);
  // The strict fusion helper returns both corroborated bridges and independent
  // unmatched direct-source records. Preserve those direct records rather than
  // accidentally dropping every LinkedIn/GMB lead when no pair is fused.
  const fusionParticipantIds = new Set([...linkedInLeads, ...googleBusinessLeads].map((lead) => lead.id));
  const unrelatedLeads = job.leads.filter((lead) => !fusionParticipantIds.has(lead.id));
  const merged = deduplicateLeads([...unrelatedLeads, ...fusion.leads].map(normalizeLead));
  job.leads = trimCandidatePool(merged, job.request);
  job.reviewCandidates = mergeReviewCandidates(job.reviewCandidates, fusion.reviewCandidates);
  const fusionLeadCount = fusion.fusedLeadIds.length;
  recordProviderCoverage(job.progress, [{
    providerId: 'linkedin-public-google-business-fusion',
    providerName: 'LinkedIn + Google Business fusion',
    status: 'returned',
    phase: 'completed',
    outcome: fusionLeadCount ? 'returned' : fusion.reviewCandidates.length ? 'filtered' : 'empty',
    leadCount: fusionLeadCount,
    attemptedCount: linkedInLeads.length,
    observedCount: linkedInLeads.length,
    acceptedCount: fusionLeadCount,
    reviewCount: fusion.reviewCandidates.length,
    deferredCount: 0,
    updatedAt: new Date(now()).toISOString(),
    message: fusionLeadCount
      ? `Final strict LinkedIn + Google Business fusion retained ${fusionLeadCount} corroborated lead${fusionLeadCount === 1 ? '' : 's'}.`
      : fusion.reviewCandidates.length
        ? `No fusion lead was retained; ${fusion.reviewCandidates.length} near-match${fusion.reviewCandidates.length === 1 ? '' : 'es'} are in the unified review queue.`
        : 'Final strict LinkedIn + Google Business fusion completed with no corroborated match.',
  }]);
  refreshProgress(job);
};

const buildQuery = (companyType: string, location: NormalizedUsLocation) =>
  `${companyType} in ${location.label}`;

const discoverRegionLeads = async (
  request: SearchRequest,
  targetLocation: NormalizedUsLocation,
  discoveryLocation: NormalizedUsLocation,
  googlePlaces: typeof googlePlacesProvider,
  discoverGoogleMapsLeads: VercelSearchServiceDeps['discoverGoogleMapsLeads'],
  discoverOsmLeads: NonNullable<VercelSearchServiceDeps['discoverOsmLeads']>,
  discoverPublicDirectories: VercelSearchServiceDeps['discoverPublicDirectories'] | undefined,
  now: () => number,
  profile = resolveCategoryProfile(request.companyType),
  deadlineMs = Date.now() + getMaxTickDurationMs(request.count),
) => {
  const candidateTargetCount = getLeadDiscoveryCandidateTarget(request.count);
  const perSeedCount = getPerSeedCount(candidateTargetCount);
  const googleRequest: SearchRequest = {
    ...request,
    city: discoveryLocation.label,
    count: perSeedCount,
  };

  const query = buildQuery(request.companyType, discoveryLocation);
  const queryVariants = buildDiscoveryQueryVariants(
    request.companyType,
    discoveryLocation,
    profile,
  );
  const warnings: ProviderWarning[] = [...profile.warnings, ...discoveryLocation.warnings];
  const googlePlacesAvailable =
    googlePlaces !== googlePlacesProvider || isGooglePlacesConfigured();
  let googlePlacesFailed = false;
  let googlePlacesError: unknown;
  let osmFailed = false;
  let osmError: unknown;
  const providerCoverage: ProviderCoverage[] = [
    {
      providerId: 'google-places',
      providerName: 'Google Places',
      status: googlePlacesAvailable ? 'configured' : 'not_configured',
      leadCount: 0,
      phase: googlePlacesAvailable ? 'queued' : 'skipped',
      outcome: googlePlacesAvailable ? 'not_started' : 'not_configured',
      attemptedCount: 0,
      observedCount: 0,
      acceptedCount: 0,
      reviewCount: 0,
      deferredCount: 0,
      updatedAt: new Date(now()).toISOString(),
      message: googlePlacesAvailable
        ? 'Configured business listing discovery source.'
        : 'Not configured; free public listing discovery remains available.',
    },
    {
      providerId: 'public-business-listings',
      providerName: 'OpenStreetMap',
      status: 'configured',
      leadCount: 0,
      phase: 'queued',
      outcome: 'not_started',
      attemptedCount: 0,
      observedCount: 0,
      acceptedCount: 0,
      reviewCount: 0,
      deferredCount: 0,
      updatedAt: new Date(now()).toISOString(),
      message: 'Independent free public listing discovery source.',
    },
    {
      providerId: 'google-maps-discovery',
      providerName: 'Public Google Maps Discovery',
      status: discoverGoogleMapsLeads ? 'configured' : 'not_configured',
      leadCount: 0,
      phase: discoverGoogleMapsLeads ? 'queued' : 'skipped',
      outcome: discoverGoogleMapsLeads ? 'not_started' : 'not_configured',
      attemptedCount: 0,
      observedCount: 0,
      acceptedCount: 0,
      reviewCount: 0,
      deferredCount: 0,
      updatedAt: new Date(now()).toISOString(),
      message: discoverGoogleMapsLeads
        ? 'Bounded fallback discovery is available when primary sources are insufficient.'
        : 'Fallback discovery is not configured for this execution path.',
    },
    {
      providerId: 'yelp-public-directory',
      providerName: 'Yelp, Public Directory',
      status: discoverPublicDirectories ? 'configured' : 'not_configured',
      leadCount: 0,
      phase: discoverPublicDirectories ? 'queued' : 'skipped',
      outcome: discoverPublicDirectories ? 'not_started' : 'not_configured',
      attemptedCount: 0,
      observedCount: 0,
      acceptedCount: 0,
      reviewCount: 0,
      deferredCount: 0,
      updatedAt: new Date(now()).toISOString(),
      message: discoverPublicDirectories
        ? 'Bounded public directory discovery runs alongside the primary listing sources.'
        : 'Yelp public-directory discovery is not configured for this execution path.',
    },
    {
      providerId: 'yellow-pages-public-directory',
      providerName: 'Yellow Pages, Public Directory',
      status: discoverPublicDirectories ? 'configured' : 'not_configured',
      leadCount: 0,
      phase: discoverPublicDirectories ? 'queued' : 'skipped',
      outcome: discoverPublicDirectories ? 'not_started' : 'not_configured',
      attemptedCount: 0,
      observedCount: 0,
      acceptedCount: 0,
      reviewCount: 0,
      deferredCount: 0,
      updatedAt: new Date(now()).toISOString(),
      message: discoverPublicDirectories
        ? 'Bounded public directory discovery runs alongside the primary listing sources.'
        : 'Yellow Pages public-directory discovery is not configured for this execution path.',
    },
  ];
  const updateCoverage = (entry: ProviderCoverage) => {
    const current = providerCoverage.find((item) => item.providerId === entry.providerId);
    if (!current) {
      providerCoverage.push(entry);
      return;
    }

    Object.assign(current, {
      ...entry,
      leadCount: Math.max(0, entry.leadCount),
      updatedAt: entry.updatedAt ?? new Date(now()).toISOString(),
    });
  };
  const googlePlacesDeadlineMs = Math.min(
    deadlineMs,
    now() + getGooglePlacesTimeoutMs(request.count),
  );

  // These sources are independent. Run them together so adding free coverage
  // does not add another full network round trip to every search seed.
  const googleLeadsPromise = (async () => {
    if (!googlePlacesAvailable) {
      warnings.push({
        providerId: 'google-places',
        providerName: 'Google Places',
        message:
          'Optional Google Places is not configured. Continuing with free OpenStreetMap and public map discovery.',
        severity: 'info',
      });
      return [] as Lead[];
    }

    try {
      return await withTimeout(
        googlePlaces.fetchLeads({
          rawQuery: request.companyType,
          query,
          queryVariants,
          request: googleRequest,
          location: discoveryLocation,
          deadlineMs: googlePlacesDeadlineMs,
        }),
        Math.max(1, googlePlacesDeadlineMs - now()),
        'Google Places discovery timed out before the regional batch completed.',
      );
    } catch (error) {
      googlePlacesFailed = true;
      googlePlacesError = error;
      warnings.push({
        providerId: 'google-places',
        providerName: 'Google Places',
        message:
          error instanceof Error
            ? error.message
            : 'Google Places discovery failed',
      });
      return [] as Lead[];
    }
  })();

  const osmLeadsPromise = (async () => {
    try {
      // Keep the free listing source independent from Google Places. A non-empty
      // Google response is not evidence that it covered the whole market.
      return await withTimeout(
        discoverOsmLeads({
          request: googleRequest,
          location: discoveryLocation,
          profile,
          deadlineMs,
        }),
        Math.max(1, deadlineMs - now()),
        'Public business-listing discovery timed out before the regional batch completed.',
      );
    } catch (error) {
      osmFailed = true;
      osmError = error;
      warnings.push({
        providerId: 'osm-discovery',
        providerName: 'OpenStreetMap',
        message:
          error instanceof Error ? error.message : 'OpenStreetMap discovery failed',
      });
      return [] as Lead[];
    }
  })();

  const publicDirectoryDeadlineMs = Math.min(
    deadlineMs,
    now() + publicDirectoryDiscoveryTimeoutMs,
  );
  const publicDirectoryPromise: Promise<PublicDirectoryDiscoveryResult | null> =
    discoverPublicDirectories
      ? withTimeout(
          discoverPublicDirectories({
            request,
            location: discoveryLocation,
            deadlineMs: publicDirectoryDeadlineMs,
          }),
          Math.max(1, publicDirectoryDeadlineMs - now()),
          'Public directory discovery timed out before the regional batch completed',
        ).catch((error) => {
          const message = error instanceof Error
            ? error.message
            : 'Public directory discovery failed.';
          const outcome: NonNullable<ProviderCoverage['outcome']> = isBlockedFailure(error)
            ? 'blocked'
            : isRateLimitedFailure(error)
              ? 'rate_limited'
              : isTimeoutFailure(error)
                ? 'timed_out'
                : 'failed';
          updateCoverage({
            providerId: 'yelp-public-directory',
            providerName: 'Yelp, Public Directory',
            status: outcome === 'failed' ? 'failed' : 'partial',
            phase: 'degraded',
            outcome,
            leadCount: 0,
            attemptedCount: 1,
            observedCount: 0,
            acceptedCount: 0,
            reviewCount: 0,
            deferredCount: 0,
            updatedAt: new Date(now()).toISOString(),
            message,
          });
          updateCoverage({
            providerId: 'yellow-pages-public-directory',
            providerName: 'Yellow Pages, Public Directory',
            status: outcome === 'failed' ? 'failed' : 'partial',
            phase: 'degraded',
            outcome,
            leadCount: 0,
            attemptedCount: 1,
            observedCount: 0,
            acceptedCount: 0,
            reviewCount: 0,
            deferredCount: 0,
            updatedAt: new Date(now()).toISOString(),
            message,
          });
          warnings.push({
            providerId: 'public-directories',
            providerName: 'Public directories',
            message: `${message} Other public sources were preserved; no access challenge was bypassed.`,
            severity: isTimeoutFailure(error) || isRateLimitedFailure(error) ? 'info' : 'warning',
          });
          return null;
        })
      : Promise.resolve(null);

  const [googleLeads, osmLeads, publicDirectoryResult] = await Promise.all([
    googleLeadsPromise,
    osmLeadsPromise,
    publicDirectoryPromise,
  ]);

  const normalizeProviderLeads = (leads: Lead[]) => leads.flatMap((lead) => {
    try {
      return [normalizeLead(lead)];
    } catch {
      return [];
    }
  });
  const collectReviewCandidates = (
    observedLeads: Lead[],
    locationScopedLeads: Lead[],
    providerId: string,
    providerName: string,
  ) => {
    const scopedIds = new Set(locationScopedLeads.map((lead) => lead.id));
    return observedLeads.flatMap((lead) => {
      if (!scopedIds.has(lead.id)) {
        return [createSourceReviewCandidate(
          lead,
          providerId,
          providerName,
          'location_mismatch',
          `The public record did not deterministically match ${targetLocation.label}, so it was not promoted.`,
        )];
      }
      if (!isPhoneQualifiedLead(lead)) {
        return [createSourceReviewCandidate(
          lead,
          providerId,
          providerName,
          lead.mobile ? 'invalid_public_phone' : 'missing_public_phone',
          lead.mobile
            ? 'The public record did not provide a validated US phone with public source evidence.'
            : 'The public record did not expose a validated public US phone route.',
        )];
      }
      return [];
    });
  };
  const observedGoogleLeads = deduplicateLeads(normalizeProviderLeads(googleLeads));
  const observedOsmLeads = deduplicateLeads(normalizeProviderLeads(osmLeads));
  const locationScopedGoogleLeads = filterLeadsForLocation(observedGoogleLeads, targetLocation);
  const locationScopedOsmLeads = filterLeadsForLocation(observedOsmLeads, targetLocation);
  const googleReviewCandidates = collectReviewCandidates(
    observedGoogleLeads,
    locationScopedGoogleLeads,
    'google-places',
    'Google Places',
  );
  const osmReviewCandidates = collectReviewCandidates(
    observedOsmLeads,
    locationScopedOsmLeads,
    'public-business-listings',
    'OpenStreetMap',
  );
  const googleFailureOutcome: NonNullable<ProviderCoverage['outcome']> = isBlockedFailure(googlePlacesError)
    ? 'blocked'
    : isRateLimitedFailure(googlePlacesError)
      ? 'rate_limited'
      : isTimeoutFailure(googlePlacesError)
        ? 'timed_out'
        : 'failed';
  const osmFailureOutcome: NonNullable<ProviderCoverage['outcome']> = isBlockedFailure(osmError)
    ? 'blocked'
    : isRateLimitedFailure(osmError)
      ? 'rate_limited'
      : isTimeoutFailure(osmError)
        ? 'timed_out'
        : 'failed';

  updateCoverage({
    providerId: 'google-places',
    providerName: 'Google Places',
    status: !googlePlacesAvailable
      ? 'not_configured'
      : googlePlacesFailed
        ? googleFailureOutcome === 'failed' ? 'failed' : 'partial'
        : 'returned',
    phase: !googlePlacesAvailable
      ? 'skipped'
      : googlePlacesFailed
        ? 'degraded'
        : 'completed',
    outcome: !googlePlacesAvailable
      ? 'not_configured'
      : googlePlacesFailed
        ? googleFailureOutcome
        : observedGoogleLeads.length
          ? 'returned'
          : 'empty',
    leadCount: locationScopedGoogleLeads.filter(isPhoneQualifiedLead).length,
    attemptedCount: googlePlacesAvailable ? 1 : 0,
    observedCount: observedGoogleLeads.length,
    acceptedCount: locationScopedGoogleLeads.filter(isPhoneQualifiedLead).length,
    reviewCount: googleReviewCandidates.length,
    deferredCount: 0,
    updatedAt: new Date(now()).toISOString(),
    message: observedGoogleLeads.length
      ? 'Business listing candidates returned.'
      : googlePlacesAvailable
        ? googlePlacesFailed
          ? (googlePlacesError instanceof Error ? googlePlacesError.message : 'Google Places discovery failed.')
          : 'Provider responded without candidates.'
        : 'Provider was not configured.',
  });
  updateCoverage({
    providerId: 'public-business-listings',
    providerName: 'OpenStreetMap',
    status: osmFailed ? osmFailureOutcome === 'failed' ? 'failed' : 'partial' : 'returned',
    phase: osmFailed ? 'degraded' : 'completed',
    outcome: osmFailed ? osmFailureOutcome : observedOsmLeads.length ? 'returned' : 'empty',
    leadCount: locationScopedOsmLeads.filter(isPhoneQualifiedLead).length,
    attemptedCount: 1,
    observedCount: observedOsmLeads.length,
    acceptedCount: locationScopedOsmLeads.filter(isPhoneQualifiedLead).length,
    reviewCount: osmReviewCandidates.length,
    deferredCount: 0,
    updatedAt: new Date(now()).toISOString(),
    message: osmFailed
      ? (osmError instanceof Error ? osmError.message : 'OpenStreetMap discovery failed.')
      : `Free public listing provider observed ${observedOsmLeads.length} deduplicated candidate(s).`,
  });

  let publicDirectoryLeads: Lead[] = [];
  let publicDirectoryReviewCandidates: ReviewCandidate[] = [];
  if (publicDirectoryResult) {
    for (const warning of publicDirectoryResult.warnings ?? []) warnings.push(warning);
    const observedDirectoryLeads = deduplicateLeads(
      normalizeProviderLeads(Array.isArray(publicDirectoryResult.leads) ? publicDirectoryResult.leads : []),
    );
    publicDirectoryLeads = filterLeadsForLocation(observedDirectoryLeads, targetLocation);
    publicDirectoryReviewCandidates = Array.isArray(publicDirectoryResult.reviewCandidates)
      ? publicDirectoryResult.reviewCandidates
      : [];
    for (const entry of publicDirectoryResult.coverage ?? []) {
      const isYelp = entry.providerId === 'yelp-public-directory';
      const isYellowPages = entry.providerId === 'yellow-pages-public-directory';
      const providerLeads = publicDirectoryLeads.filter((lead) =>
        isYelp
          ? lead.source.trim().toLowerCase().includes('yelp')
          : isYellowPages
            ? lead.source.trim().toLowerCase().includes('yellow pages')
            : false,
      );
      const providerReviews = publicDirectoryReviewCandidates.filter((candidate) =>
        candidate.providerId === entry.providerId,
      );
      updateCoverage({
        ...entry,
        leadCount: providerLeads.filter(isPhoneQualifiedLead).length,
        acceptedCount: providerLeads.filter(isPhoneQualifiedLead).length,
        reviewCount: providerReviews.length,
        updatedAt: new Date(now()).toISOString(),
      });
    }
  }

  if (!observedGoogleLeads.length && !observedOsmLeads.length && !publicDirectoryLeads.length) {
    warnings.push({
      providerId: 'discovery',
      providerName: 'Discovery',
      message: `No discovery candidates returned for ${discoveryLocation.label}`,
    });
  }

  const locationScopedDiscoveryLeads = deduplicateLeads([
    ...locationScopedGoogleLeads,
    ...locationScopedOsmLeads,
    ...publicDirectoryLeads,
  ]);
  let googleMapsLeads: Lead[] = [];
  let googleMapsReviewCandidates: ReviewCandidate[] = [];
  let googleMapsUnavailable = false;

  if (
    locationScopedDiscoveryLeads.length < candidateTargetCount &&
    locationScopedDiscoveryLeads.filter(isPhoneQualifiedLead).length < request.count &&
    discoverGoogleMapsLeads
  ) {
    try {
      const remainingCount = candidateTargetCount - locationScopedDiscoveryLeads.length;
      const googleMapsRequestCount = Math.min(Math.max(remainingCount, 15), 60);
      const googleMapsDeadlineMs = Math.min(
        deadlineMs,
        now() + getGoogleMapsTimeoutMs(request.count),
      );
      const observedGoogleMapsLeads = deduplicateLeads(normalizeProviderLeads(await withTimeout(
        discoverGoogleMapsLeads({
          request: {
            ...request,
            count: googleMapsRequestCount,
        },
        location: discoveryLocation,
        queryVariants,
        maxResults: googleMapsRequestCount,
          queryLimit: getResearchDepthConfig(request.researchDepth).googleMapsQueryLimit,
          deadlineMs: googleMapsDeadlineMs,
        }),
        Math.max(1, googleMapsDeadlineMs - now()),
        'Public Google Maps discovery timed out before the regional batch completed.',
      )));
      googleMapsLeads = filterLeadsForLocation(observedGoogleMapsLeads, targetLocation);
      googleMapsReviewCandidates = collectReviewCandidates(
        observedGoogleMapsLeads,
        googleMapsLeads,
        'google-maps-discovery',
        'Public Google Maps Discovery',
      );
      updateCoverage({
        providerId: 'google-maps-discovery',
        providerName: 'Public Google Maps Discovery',
        status: 'returned',
        phase: 'completed',
        outcome: observedGoogleMapsLeads.length ? 'returned' : 'empty',
        leadCount: googleMapsLeads.filter(isPhoneQualifiedLead).length,
        attemptedCount: 1,
        observedCount: observedGoogleMapsLeads.length,
        acceptedCount: googleMapsLeads.filter(isPhoneQualifiedLead).length,
        reviewCount: googleMapsReviewCandidates.length,
        deferredCount: 0,
        updatedAt: new Date(now()).toISOString(),
        message: `Bounded fallback discovery observed ${observedGoogleMapsLeads.length} candidate(s).`,
      });
    } catch (error) {
      googleMapsUnavailable = true;
      const outcome: NonNullable<ProviderCoverage['outcome']> = isBlockedFailure(error)
        ? 'blocked'
        : isRateLimitedFailure(error)
          ? 'rate_limited'
          : isTimeoutFailure(error)
            ? 'timed_out'
            : 'failed';
      updateCoverage({
        providerId: 'google-maps-discovery',
        providerName: 'Public Google Maps Discovery',
        status: outcome === 'failed' ? 'failed' : 'partial',
        phase: 'degraded',
        outcome,
        leadCount: 0,
        attemptedCount: 1,
        observedCount: 0,
        acceptedCount: 0,
        reviewCount: 0,
        deferredCount: 0,
        updatedAt: new Date(now()).toISOString(),
        message: error instanceof Error ? error.message : 'Public Google Maps discovery failed.',
      });
      warnings.push({
        providerId: 'google-maps',
        providerName: 'Google Maps',
        message: formatGoogleMapsFailure(error),
      });
    }
  }

  return {
    leads: deduplicateLeads([...locationScopedDiscoveryLeads, ...googleMapsLeads]),
    reviewCandidates: [...new Map([
      ...googleReviewCandidates,
      ...osmReviewCandidates,
      ...publicDirectoryReviewCandidates,
      ...googleMapsReviewCandidates,
    ].map((candidate) => [candidate.id, candidate] as const)).values()],
    warnings,
    googleMapsUnavailable,
    providerCoverage,
  };
};

const tickJob = async (
  job: SearchJobRecord,
  store: ReturnType<typeof createSearchJobStore>,
  deps: Required<Pick<VercelSearchServiceDeps, 'googlePlaces' | 'normalizeLocation' | 'discoverOsmLeads' | 'now'>> &
    Pick<
      VercelSearchServiceDeps,
      | 'discoverGoogleMapsLeads'
      | 'discoverPublicDirectories'
      | 'discoverAiLeads'
      | 'runGeminiPublicResearch'
      | 'discoverOsmLeadsBatch'
      | 'enrichWebsiteLead'
    >,
): Promise<SearchJobRecord> => {
  if (job.cancelRequested || job.status === 'cancelled') {
    job.status = 'cancelled';
    job.progress.currentSource = 'Cancelled';
    return job;
  }

  let targetLocation = job.targetLocation as NormalizedUsLocation | undefined;
  const shouldInitializeLocation = !targetLocation;

  if (!targetLocation) {
    try {
      targetLocation = await deps.normalizeLocation(job.request.city);
      job.targetLocation = targetLocation;
    } catch (error) {
      appendWarningOnce(job, {
        providerId: 'nominatim',
        providerName: 'Nominatim',
        message:
          error instanceof Error ? error.message : 'US location normalization failed',
      });
      job.status = 'discovering';
      job.progress.currentSource = 'Nominatim';
      job.updatedAt = withNow();
      await store.upsert(job);
      return job;
    }
  }

  if (job.status === 'failed' || job.status === 'complete') {
    return job;
  }

  const sourceMode: LeadSourceMode = normalizeLeadSourceMode(job.request.sourceMode);
  if (job.request.sourceMode !== sourceMode) {
    job.request = { ...job.request, sourceMode };
  }
  const candidateTargetCount = getLeadDiscoveryCandidateTarget(job.request.count);
  const discoverGoogleMapsForSearch = deps.discoverGoogleMapsLeads
    ? async (
        args: Parameters<NonNullable<VercelSearchServiceDeps['discoverGoogleMapsLeads']>>[0],
      ) => {
        if (job.googleMapsUnavailable) {
          return [];
        }

        return deps.discoverGoogleMapsLeads?.(args) ?? [];
      }
    : undefined;

  if (shouldInitializeLocation) {
    job.locationLabel = targetLocation.label;
    job.locationMode = targetLocation.mode;
    job.query =
      targetLocation.mode === 'nationwide'
        ? `${job.request.companyType} in United States`
        : buildQuery(job.request.companyType, targetLocation);
    for (const warning of targetLocation.warnings) {
      appendWarningOnce(job, warning);
    }
  }

  if (sourceMode === 'ai') {
    const discoverAiLeads = deps.discoverAiLeads ?? discoverUsLeadsFromAiMode;
    const tickStartedAt = deps.now();
    const workflow = job.aiWorkflow ?? {
      startedAt: tickStartedAt,
      logicalDeadlineAt: tickStartedAt + aiLogicalBudgetMs,
      stage: 'source_discovery' as const,
      websitePasses: 0,
      osmBoxCursor: 0,
      osmContinuationPasses: 0,
      geminiPending: false,
    };
    job.aiWorkflow = workflow;

    if (workflow.stage === 'source_discovery') {
      let sourceResult: AiDiscoveryResult | undefined;
      try {
        job.status = 'discovering';
        job.progress.currentSource = leadSourceModeLabels.ai;
        job.updatedAt = tickStartedAt;
        await store.upsert(job);
        sourceResult = await runAiDiscovery(
          job,
          job.request,
          targetLocation,
          discoverAiLeads,
          deps.now,
          Math.min(
            workflow.logicalDeadlineAt,
            tickStartedAt + getAiDiscoveryWindowMs(job.request.count),
          ),
          workflow.osmBoxCursor ?? 0,
          maxAiOsmBoxesPerTick,
        );
      } catch (error) {
        appendWarningOnce(job, {
          providerId: 'ai-mode',
          providerName: 'AI mode',
          message:
            error instanceof Error
              ? error.message
              : 'Bounded public-source discovery failed. No unverified leads were added.',
        });
        recordProviderCoverage(job.progress, [{
          providerId: 'ai-mode',
          providerName: 'AI mode',
          status: 'failed',
          phase: 'degraded',
          outcome: 'failed',
          leadCount: 0,
          attemptedCount: 1,
          observedCount: 0,
          acceptedCount: 0,
          reviewCount: 0,
          deferredCount: 0,
          updatedAt: new Date(deps.now()).toISOString(),
          message: 'The bounded public-source stage failed; remaining safe stages will still run.',
        }]);
      }

      const publicListingProgress = sourceResult?.publicListingProgress;
      if (publicListingProgress) {
        workflow.osmBoxCursor = publicListingProgress.nextBoxCursor;
        workflow.osmTotalBoxes = publicListingProgress.totalBoxCount;
      }
      workflow.geminiPending = Boolean(sourceResult?.geminiDeferred);
      const shouldContinuePublicListings = Boolean(
        publicListingProgress &&
        !publicListingProgress.completed &&
        deps.now() + aiOsmContinuationTickWindowMs + aiGeminiTickWindowMs < workflow.logicalDeadlineAt,
      );
      workflow.stage = shouldContinuePublicListings
        ? 'public_listing_continuation'
        : workflow.geminiPending
          ? 'gemini_public_research'
          : 'website_enrichment';
      job.status = 'enriching';
      job.progress.currentSource = shouldContinuePublicListings
        ? 'Public business listings'
        : workflow.geminiPending
          ? 'Gemini public discovery'
          : 'Public website enrichment';
      job.updatedAt = deps.now();
      job.expiresAt = deps.now() + jobTtlMs;
      await store.upsert(job);
      return job;
    }

    if (workflow.stage === 'public_listing_continuation') {
      const continuationStartedAt = deps.now();
      const discoverOsmBatch = deps.discoverOsmLeadsBatch ?? discoverUsLeadsFromOsmBatch;
      job.status = 'discovering';
      job.progress.currentSource = 'Public business listings';
      job.updatedAt = continuationStartedAt;
      await store.upsert(job);

      let continuation: OsmDiscoveryBatchResult | undefined;
      try {
        continuation = await runAiPublicListingContinuation(
          job,
          targetLocation,
          discoverOsmBatch,
          deps.now,
          Math.min(
            workflow.logicalDeadlineAt,
            continuationStartedAt + aiOsmContinuationTickWindowMs,
          ),
          workflow.osmBoxCursor ?? 0,
        );
        workflow.osmBoxCursor = continuation.nextBoxCursor;
        workflow.osmTotalBoxes = continuation.totalBoxCount;
      } catch (error) {
        const timedOut = isTimeoutFailure(error);
        appendWarningOnce(job, {
          providerId: 'public-business-listings',
          providerName: 'Public Business Listings',
          message:
            error instanceof Error
              ? `${error.message} Remaining public listing work was preserved.`
              : 'The bounded public-listing continuation failed; remaining work was preserved.',
          severity: timedOut ? 'info' : 'warning',
        });
        recordProviderCoverage(job.progress, [{
          providerId: 'public-business-listings',
          providerName: 'Public Business Listings',
          status: timedOut ? 'partial' : 'failed',
          phase: 'degraded',
          outcome: timedOut ? 'timed_out' : 'failed',
          leadCount: 0,
          attemptedCount: 1,
          observedCount: 0,
          acceptedCount: 0,
          reviewCount: 0,
          deferredCount: Math.max(
            0,
            (workflow.osmTotalBoxes ?? 0) - (workflow.osmBoxCursor ?? 0),
          ),
          updatedAt: new Date(deps.now()).toISOString(),
          message: 'Public business-listing continuation did not finish in this bounded tick.',
        }]);
      }

      workflow.osmContinuationPasses = (workflow.osmContinuationPasses ?? 0) + 1;
      const mayContinuePublicListings = Boolean(
        continuation &&
        !continuation.completed &&
        deps.now() + aiOsmContinuationTickWindowMs + aiGeminiTickWindowMs < workflow.logicalDeadlineAt &&
        workflow.osmContinuationPasses < maxAiOsmContinuationPasses,
      );
      if (!mayContinuePublicListings) {
        workflow.stage = workflow.geminiPending
          ? 'gemini_public_research'
          : 'website_enrichment';
      }
      job.status = 'enriching';
      job.progress.currentSource = mayContinuePublicListings
        ? 'Public business listings'
        : workflow.geminiPending
          ? 'Gemini public discovery'
          : 'Public website enrichment';
      job.updatedAt = deps.now();
      job.expiresAt = deps.now() + jobTtlMs;
      await store.upsert(job);
      return job;
    }

    if (workflow.stage === 'gemini_public_research') {
      const geminiTickStartedAt = deps.now();
      job.status = 'enriching';
      job.progress.currentSource = 'Gemini public discovery';
      job.updatedAt = geminiTickStartedAt;
      await store.upsert(job);

      try {
        const geminiResult = await runAiGroundedGeminiResearch(
          job,
          targetLocation,
          deps.runGeminiPublicResearch ?? runGroundedGeminiPublicResearch,
          deps.now,
          Math.min(workflow.logicalDeadlineAt, geminiTickStartedAt + aiGeminiTickWindowMs),
        );
        // One logical search makes at most one grounded Gemini request. A
        // no-time deferral remains visible on the final snapshot rather than
        // turning into a misleading retry loop or an "Unavailable" result.
        workflow.geminiPending = geminiResult.deferred;
      } catch (error) {
        const timedOut = isTimeoutFailure(error);
        appendWarningOnce(job, {
          providerId: 'gemini-public-discovery',
          providerName: 'Gemini public discovery',
          message: error instanceof Error
            ? `${error.message} Deterministic public sources were preserved.`
            : 'Gemini public discovery failed; deterministic public sources were preserved.',
          severity: timedOut ? 'info' : 'warning',
        });
        recordProviderCoverage(job.progress, [{
          providerId: 'gemini-public-discovery',
          providerName: 'Gemini public discovery',
          status: timedOut ? 'partial' : 'failed',
          phase: 'degraded',
          outcome: timedOut ? 'timed_out' : 'failed',
          leadCount: 0,
          attemptedCount: 1,
          observedCount: 0,
          acceptedCount: 0,
          reviewCount: 0,
          deferredCount: 0,
          updatedAt: new Date(deps.now()).toISOString(),
          message: 'The bounded Gemini public-research tick did not complete; deterministic public sources were preserved.',
        }]);
        workflow.geminiPending = false;
      }

      workflow.stage = 'website_enrichment';
      job.status = 'enriching';
      job.progress.currentSource = 'Public website enrichment';
      job.updatedAt = deps.now();
      job.expiresAt = deps.now() + jobTtlMs;
      await store.upsert(job);
      return job;
    }

    if (workflow.stage === 'website_enrichment') {
      const websiteTickStartedAt = deps.now();
      job.status = 'enriching';
      job.progress.currentSource = 'Public website enrichment';
      job.updatedAt = websiteTickStartedAt;
      await store.upsert(job);

      let websiteResult: Awaited<ReturnType<typeof runAiWebsiteEnrichment>>;
      try {
        websiteResult = await runAiWebsiteEnrichment(
          job,
          deps.enrichWebsiteLead,
          deps.now,
          Math.min(workflow.logicalDeadlineAt, websiteTickStartedAt + aiWebsiteTickWindowMs),
          workflow,
        );
      } catch (error) {
        appendWarningOnce(job, {
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          message:
            error instanceof Error
              ? error.message
              : 'The bounded public website stage failed; source records were preserved.',
        });
        recordProviderCoverage(job.progress, [{
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          status: 'failed',
          phase: 'degraded',
          outcome: 'failed',
          leadCount: 0,
          attemptedCount: 0,
          observedCount: 0,
          acceptedCount: 0,
          reviewCount: 0,
          deferredCount: 0,
          updatedAt: new Date(deps.now()).toISOString(),
          message: 'Public website enrichment failed within its bounded tick; source records were preserved.',
        }]);
      }

      workflow.websitePasses = (workflow.websitePasses ?? 0) + 1;
      const mayResumeDeferredWebsites =
        Boolean(websiteResult?.deferredCount) &&
        deps.now() < workflow.logicalDeadlineAt;
      if (!mayResumeDeferredWebsites) {
        workflow.stage = 'final_fusion';
      }
      job.updatedAt = deps.now();
      job.expiresAt = deps.now() + jobTtlMs;
      await store.upsert(job);
      return job;
    }

    if (workflow.stage === 'final_fusion') {
      job.status = 'enriching';
      job.progress.currentSource = 'Final LinkedIn + Google Business fusion';
      job.updatedAt = deps.now();
      await store.upsert(job);
      runAiFinalFusion(job, deps.now);
      workflow.stage = 'completed';
      job.discoveryComplete = true;
      finalizeJobStatus(job);
      job.updatedAt = deps.now();
      await store.upsert(job);
      return job;
    }

    job.discoveryComplete = true;
    finalizeJobStatus(job);
    job.updatedAt = deps.now();
    await store.upsert(job);
    return job;
  }

  if (!job.searchSeeds.length) {
    job.searchSeeds = buildDiscoverySeeds(targetLocation);
    job.status = 'discovering';
    job.progress.currentSource = 'Google Places API';
  }

  if (job.nextSeedIndex < job.searchSeeds.length) {
    job.status = 'discovering';
    job.progress.currentSource = 'Google Places API';
    const discoveryBatchSize = getDiscoveryBatchSize(job.request.count);
    const maxTickDurationMs = getMaxTickDurationMs(job.request.count);

    let processed = 0;
    while (job.nextSeedIndex < job.searchSeeds.length && processed < discoveryBatchSize) {
      const seed = job.searchSeeds[job.nextSeedIndex];
      let regionalLocation: NormalizedUsLocation;
      try {
        regionalLocation = await deps.normalizeLocation(seed);
      } catch (error) {
        appendWarningOnce(job, {
          providerId: 'nominatim',
          providerName: 'Nominatim',
          message:
            error instanceof Error ? error.message : 'US location normalization failed',
        });
        job.nextSeedIndex += 1;
        job.progress.batchesCompleted += 1;
        processed += 1;
        job.expiresAt = withNow() + jobTtlMs;
        continue;
      }

      const foundCountBeforeRegional = job.leads.length;
      const {
        leads,
        reviewCandidates,
        warnings,
        googleMapsUnavailable,
        providerCoverage,
      } = await discoverRegionLeads(
        job.request,
        targetLocation,
        regionalLocation,
        deps.googlePlaces,
        discoverGoogleMapsForSearch,
        deps.discoverOsmLeads,
        deps.discoverPublicDirectories,
        deps.now,
        resolveCategoryProfile(job.request.companyType),
        deps.now() + maxTickDurationMs,
      );

      job.providerWarnings.push(...warnings);
      recordProviderCoverage(job.progress, providerCoverage);
      mergeLeads(job, leads, deps.now);
      job.reviewCandidates = mergeReviewCandidates(job.reviewCandidates, reviewCandidates);

      if (
        deps.enrichWebsiteLead &&
        (!hasRequestedPhoneCandidates(job) || hasWebsiteDecisionMakerCandidates(job))
      ) {
        const websiteResult = await enrichWebsiteCandidates({
          leads: job.leads,
          enrichLead: deps.enrichWebsiteLead,
          deadlineMs: deps.now() + Math.min(12_000, maxTickDurationMs),
          includeDecisionMakerNames: true,
          now: deps.now,
        });
        for (const warning of websiteResult.warnings) {
          appendWarningOnce(job, warning);
        }
        recordProviderCoverage(job.progress, [{
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          status: websiteResult.blockedCount || websiteResult.timedOutCount
            ? 'partial'
            : 'returned',
          phase: websiteResult.blockedCount || websiteResult.timedOutCount
            ? 'degraded'
            : websiteResult.deferredCount
              ? 'queued'
              : 'completed',
          outcome: websiteResult.blockedCount
            ? 'blocked'
            : websiteResult.timedOutCount
              ? 'timed_out'
              : websiteResult.deferredCount
                ? 'deferred'
                : websiteResult.enrichedCount
                  ? 'returned'
                  : 'empty',
          leadCount: websiteResult.enrichedCount,
          attemptedCount: websiteResult.attemptedCount,
          observedCount: websiteResult.candidateCount,
          acceptedCount: websiteResult.enrichedCount,
          reviewCount: websiteResult.reviewCandidates.length,
          deferredCount: websiteResult.deferredCount,
          completedCount: websiteResult.completedCount,
          enrichedCount: websiteResult.enrichedCount,
          blockedCount: websiteResult.blockedCount,
          timedOutCount: websiteResult.timedOutCount,
          skippedCount: websiteResult.skippedCount,
          decisionMakerRecoveredCount: websiteResult.decisionMakerRecoveredCount,
          updatedAt: new Date(deps.now()).toISOString(),
          message: `Website enrichment: ${websiteResult.attemptedCount} attempted, ${websiteResult.completedCount} completed, ${websiteResult.enrichedCount} enriched, ${websiteResult.blockedCount} blocked, ${websiteResult.timedOutCount} timed out, ${websiteResult.skippedCount} skipped, ${websiteResult.deferredCount} deferred, ${websiteResult.decisionMakerRecoveredCount} public decision-maker name${websiteResult.decisionMakerRecoveredCount === 1 ? '' : 's'} recovered.`,
        }]);
        job.reviewCandidates = mergeReviewCandidates(
          job.reviewCandidates,
          websiteResult.reviewCandidates,
        );
        if (websiteResult.leads.length) {
          mergeLeads(job, websiteResult.leads, deps.now, false);
          job.progress.enriched += websiteResult.enrichedCount;
        }
      }

      if (googleMapsUnavailable) {
        job.googleMapsUnavailable = true;
      }

      if (
        job.googleMapsUnavailable &&
        job.leads.length === foundCountBeforeRegional
      ) {
        job.discoveryComplete = true;
        appendWarningOnce(job, {
          providerId: 'discovery-limit',
          providerName: 'Discovery',
          message:
            'Google Maps fallback was unavailable and other sources returned no new businesses. Search completed with the available results.',
        });
        job.nextSeedIndex = job.searchSeeds.length;
        break;
      }
      job.nextSeedIndex += 1;
      job.progress.batchesCompleted += 1;
      processed += 1;
      job.expiresAt = withNow() + jobTtlMs;

      if (job.leads.length >= candidateTargetCount || hasRequestedPhoneCandidates(job)) {
        break;
      }
    }
  }

  job.discoveryComplete = job.nextSeedIndex >= job.searchSeeds.length;
  const stalledForTooLong =
    job.leads.length < candidateTargetCount &&
    !hasRequestedPhoneCandidates(job) &&
    deps.now() - getLastProgressAt(job) >= getDiscoveryStallMs(job.request.count);

  if (stalledForTooLong) {
    job.discoveryComplete = true;
    appendWarningOnce(job, {
      providerId: 'discovery-limit',
      providerName: 'Discovery',
      message:
        `No new businesses were returned after ${getDiscoveryStallLabel(job.request.count)}. Search stopped after verifying the available results.`,
    });
  }

  if (
    job.leads.length >= candidateTargetCount ||
    hasRequestedPhoneCandidates(job) ||
    job.discoveryComplete
  ) {
    finalizeJobStatus(job);
  } else {
    job.status = 'discovering';
    job.progress.currentSource = 'Google Places API';
  }

  refreshProgress(job);
  job.updatedAt = withNow();
  await store.upsert(job);
  return job;
};

export const createVercelSearchService = (): VercelSearchService => {
  return createVercelSearchServiceWithDeps({});
};

export const createVercelSearchServiceWithDeps = (
  deps: VercelSearchServiceDeps,
): VercelSearchService => {
  const store = deps.store ?? createSearchJobStore();
  const feedbackStore = deps.feedbackStore ?? createLeadFeedbackStore();
  const queue = deps.queue ?? createResearchQueue();
  const inFlightTicks = new Map<string, Promise<SearchJobRecord>>();
  const googlePlaces = deps.googlePlaces ?? googlePlacesProvider;
  const normalizeLocation = deps.normalizeLocation ?? normalizeUsLocation;
  const discoverGoogleMapsLeads =
    deps.discoverGoogleMapsLeads ??
    (process.env.NODE_ENV === 'test' || isVercelRuntime()
      ? undefined
      : discoverGoogleMapsLeadsOnDemand);
  const discoverAiLeads = deps.discoverAiLeads ?? discoverUsLeadsFromAiMode;
  const runGeminiPublicResearch = deps.runGeminiPublicResearch ?? runGroundedGeminiPublicResearch;
  const enrichWebsiteLead =
    deps.enrichWebsiteLead ??
    (process.env.NODE_ENV === 'test' ? undefined : enrichLeadFromWebsite);
  const discoverOsm = deps.discoverOsmLeads ?? discoverUsLeadsFromOsm;
  const discoverOsmBatch = deps.discoverOsmLeadsBatch ?? discoverUsLeadsFromOsmBatch;
  const discoverPublicDirectories =
    deps.discoverPublicDirectories ??
    (isTestRuntime() ? undefined : discoverUsLeadsFromPublicDirectories);
  const now = deps.now ?? withNow;
  const idFactory = deps.idFactory ?? randomUUID;
  const deliverCallback = deps.deliverCallback ?? deliverSearchCompletionCallback;
  const renderResponse = async (job: SearchJobRecord, ownerId?: string) => {
    const suppressionKeys = ownerId
      ? await feedbackStore.getSuppressionKeys(ownerId)
      : new Set<string>();
    return toSearchResponse(job, suppressionKeys);
  };
  const deliverCallbackForJob = async (job: SearchJobRecord) => {
    if (!['complete', 'failed', 'cancelled'].includes(job.status)) {
      return job;
    }

    try {
      return await deliverCallback({
        job,
        response: await renderResponse(job, job.ownerId),
        store,
        now,
        fetchImplementation: deps.callbackFetch,
      });
    } catch (error) {
      // Callback delivery must not turn a completed search into a 500. The
      // durable callback state remains pending and can be retried later.
      console.error('[vercel-search-service] completion callback failed', error);
      return job;
    }
  };
  const getStoredSearch = async (searchId: string, context?: SearchAccessContext) => {
    await store.ensureSchema();

    const job = await store.get(searchId, context?.ownerId);
    return job ? renderResponse(job, context?.ownerId) : null;
  };

  const advanceSearch = async (searchId: string, ownerId?: string) => {
    await store.ensureSchema();

    const job = await store.get(searchId, ownerId);
    if (!job) {
      return null;
    }

    // Keep one provider tick per warm function instance. The durable snapshot
    // remains the source of truth when another request overlaps this work.
    const existingTick = inFlightTicks.get(searchId);
    if (existingTick) {
      return renderResponse(job, ownerId);
    }

    const processingToken = randomUUID();
    const claimedJob = await store.claim(
      searchId,
      now(),
      processingLeaseMs,
      processingToken,
      ownerId,
    );

    if (!claimedJob) {
      const latestJob = await store.get(searchId, ownerId);
      return latestJob ? renderResponse(latestJob, ownerId) : null;
    }

    const tick = tickJob(claimedJob, store, {
      googlePlaces,
      normalizeLocation,
      discoverGoogleMapsLeads,
      discoverAiLeads,
      runGeminiPublicResearch,
      enrichWebsiteLead,
      discoverOsmLeads: discoverOsm,
      discoverOsmLeadsBatch: discoverOsmBatch,
      discoverPublicDirectories,
      now,
    });
    inFlightTicks.set(searchId, tick);

    try {
      const processedJob = await deliverCallbackForJob(await tick);
      return renderResponse(processedJob, ownerId);
    } finally {
      if (inFlightTicks.get(searchId) === tick) {
        inFlightTicks.delete(searchId);
      }

      try {
        const latestJob = await store.get(searchId);
        if (latestJob?.processingToken === processingToken) {
          latestJob.processingToken = undefined;
          latestJob.processingUntil = undefined;
          latestJob.updatedAt = now();
          await store.upsert(latestJob);
        }
      } catch (error) {
        console.error('[vercel-search-service] failed to release search lease', error);
      }
    }
  };

  return {
    async startSearch(request, context) {
      await store.ensureSchema();
      const startedAt = now();
      await store.deleteExpired(startedAt);

      const normalizedCallback = normalizeCallbackRequest(request.callback);
      const normalizedRequest: SearchRequest = {
        ...request,
        sourceMode: normalizeLeadSourceMode(request.sourceMode),
        phoneRequired: true,
        researchDepth: request.researchDepth ?? 'verified',
        ...(normalizedCallback ? { callback: normalizedCallback } : { callback: undefined }),
      };
      const idempotencyKey = normalizeIdempotencyKey(context?.idempotencyKey);
      const requestFingerprint = createSearchRequestFingerprint(normalizedRequest);

      if (idempotencyKey) {
        const existingJob = await store.getByIdempotencyKey(
          idempotencyKey,
          requestFingerprint,
          startedAt,
          context?.ownerId,
        );
        if (existingJob) {
          return renderResponse(existingJob, context?.ownerId);
        }
      }

      const searchId = idFactory();
      const createdAt = startedAt;
      let job: SearchJobRecord = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        searchId,
        ownerId: context?.ownerId,
        idempotencyKey,
        requestFingerprint,
        request: normalizedRequest,
        callback: normalizedCallback
          ? createSearchCallbackState(normalizedCallback.url, createdAt)
          : undefined,
        query: `${normalizedRequest.companyType} in ${normalizedRequest.city}`,
        locationLabel: normalizedRequest.city,
        locationMode: 'local',
        status: 'queued',
        progress: createProgress(normalizedRequest.count),
        leads: [],
        researchCandidates: [],
        reviewCandidates: [],
        providerWarnings: [],
        searchSeeds: [],
        nextSeedIndex: 0,
        discoveryComplete: false,
        lastProgressAt: createdAt,
        expiresAt: createdAt + jobTtlMs,
        createdAt,
        updatedAt: createdAt,
      };

      const created = await store.create(job);
      if (!created.created) {
        return renderResponse(created.job, context?.ownerId);
      }

      await queue.enqueue(searchId, createdAt);

      return renderResponse(job, context?.ownerId);
    },

    async cancelSearch(searchId, context) {
      await store.ensureSchema();
      const cancelled = await store.requestCancel(searchId, now(), context?.ownerId);
      if (!cancelled) return null;

      const processed = await deliverCallbackForJob(cancelled);
      if (processed.callback && ['pending', 'retrying'].includes(processed.callback.status)) {
        await queue.enqueue(searchId, processed.callback.nextAttemptAt ?? now());
      }
      return renderResponse(processed, context?.ownerId);
    },

    async resumeSearch(searchId, context) {
      await store.ensureSchema();
      const job = await store.get(searchId, context?.ownerId);

      if (!job) {
        return null;
      }

      if (job.status === 'cancelled') {
        job.cancelRequested = false;
        job.status = 'discovering';
        job.discoveryComplete = false;
        job.progress.currentSource = 'Resuming research';
        job.lastProgressAt = now();
        job.updatedAt = now();
        if (job.request.callback) {
          job.callback = createSearchCallbackState(job.request.callback.url, now());
        }
        await store.upsert(job);
        await queue.enqueue(searchId, now());
      }

      return renderResponse(job, context?.ownerId);
    },

    async reverifySearch(searchId, context) {
      await store.ensureSchema();
      const job = await store.get(searchId, context?.ownerId);

      if (!job) {
        return null;
      }

      job.leads = reverifyLeads(job.leads);
      appendWarningOnce(job, {
        providerId: 'reverification',
        providerName: 'Deterministic verification',
        message:
          'Reverification refreshed public phone, email, website, evidence, and scores without refetching provider pages.',
        severity: 'info',
      });
      finalizeJobStatus(job);
      job.updatedAt = now();
      await store.upsert(job);

      return renderResponse(job, context?.ownerId);
    },

    async getSearch(searchId, context) {
      const accessible = await store.get(searchId, context?.ownerId);
      if (!accessible) {
        return null;
      }

      return context?.ownerId
        ? advanceSearch(searchId, context.ownerId)
        : advanceSearch(searchId);
    },

    async recordFeedback(searchId, feedback, context) {
      if (!context?.ownerId) {
        return null;
      }

      await store.ensureSchema();
      const job = await store.get(searchId, context.ownerId);
      if (!job) return null;

      const qualifiedLead = enforcePhoneRequirement(
        deduplicateLeads(job.leads),
        job.request,
      ).leads.find((lead) => lead.id === feedback.leadId);
      if (!qualifiedLead) return null;

      await feedbackStore.recordFeedback({
        searchId,
        ownerId: context.ownerId,
        leadId: feedback.leadId,
        eventType: feedback.eventType,
        reason: feedback.reason,
        entityKey: getLeadFeedbackEntityKey(qualifiedLead, feedback.eventType),
        suppressionKeys: getLeadFeedbackSuppressionKeys(qualifiedLead, feedback.eventType),
      });

      const latest = await store.get(searchId, context.ownerId);
      return latest ? renderResponse(latest, context.ownerId) : null;
    },

    getSearchSnapshot: getStoredSearch,
    advanceSearch,
  };
};

export const vercelSearchService = createVercelSearchService();
