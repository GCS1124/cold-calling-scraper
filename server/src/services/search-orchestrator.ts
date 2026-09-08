import { randomUUID } from 'node:crypto';

import type { Lead, ResearchCandidate } from '../types/lead';
import type {
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
import { enrichLeads } from './lead-validation';
import {
  googlePlacesProvider,
  isGooglePlacesConfigured,
} from '../providers/google-places';
import { discoverUsLeadsFromOsm } from './osm-discovery';
import {
  discoverUsLeadsFromGoogleMaps,
  formatGoogleMapsFailure,
} from './google-maps-discovery';
import {
  discoverUsLeadsFromAiMode,
  type AiDiscoveryResult,
} from './ai-lead-discovery';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { resolveCategoryProfile } from './us-category-mapping';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';
import { filterLeadsForLocation } from './location-acceptance';
import { enforcePhoneRequirement, isPhoneQualifiedLead } from './phone-requirement';
import { buildDiscoverySeeds } from './discovery-seeds';
import {
  leadSourceModeLabels,
  normalizeLeadSourceMode,
  type LeadSourceMode,
} from './search-source-mode';
import { getResearchDepthConfig } from './research-depth';
import { getLeadDiscoveryCandidateTarget } from './lead-discovery-budget';
import { reverifyLeads } from './research-reverification';
import { noUsableResultsWarning } from './search-finalization';
import { enrichLeadFromWebsite } from './website-enrichment';
import { enrichWebsiteCandidates, type WebsiteLeadEnricher } from './business-website-enrichment';
import {
  buildSearchExecutionContract,
  buildSearchResponseContract,
} from '../../../shared/search-contract';
import { recordProviderCoverage } from './provider-coverage';
import { buildLeadQualitySummary } from './quality-summary';
import {
  createSearchRequestFingerprint,
  normalizeIdempotencyKey,
  SearchIdempotencyConflictError,
} from './search-idempotency';
import { createLeadFeedbackStore, type LeadFeedbackStore } from './lead-feedback-store';
import {
  filterSuppressedLeads,
  getLeadFeedbackEntityKey,
  getLeadFeedbackSuppressionKeys,
} from '../../../shared/lead-feedback';

type SearchJob = {
  searchId: string;
  ownerId?: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
  request: SearchRequest;
  leads: Lead[];
  locationLabel: string;
  query: string;
  status: SearchStatus;
  progress: SearchProgress;
  providerWarnings: ProviderWarning[];
  researchCandidates?: ResearchCandidate[];
  expiresAt: number;
  createdAt: number;
  lastProgressAt: number;
  googleMapsUnavailable?: boolean;
  cancelRequested?: boolean;
  executionToken: string;
};

type SearchService = {
  startSearch: (
    request: SearchRequest,
    context?: SearchStartContext,
  ) => Promise<SearchResponse>;
  getSearch: (
    searchId: string,
    context?: SearchAccessContext,
  ) => Promise<SearchResponse | null>;
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

type SearchDeps = {
  normalizeLocation?: (rawLocation: string) => Promise<NormalizedUsLocation>;
  enrichLead?: (lead: Lead) => Lead | Promise<Lead>;
  enrichWebsiteLead?: WebsiteLeadEnricher;
  discoverGoogleLeads?: typeof googlePlacesProvider | ((args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    queryVariants: string[];
    deadlineMs?: number;
  }) => Promise<Lead[]>);
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
  }) => Promise<AiDiscoveryResult>;
  discoverOsmLeads?: (args: {
    request: { companyType: string; count: number };
    location: NormalizedUsLocation;
    profile: ReturnType<typeof resolveCategoryProfile>;
    deadlineMs?: number;
  }) => Promise<Lead[]>;
  schedule?: (task: () => Promise<void>) => void;
  now?: () => number;
  idFactory?: () => string;
  feedbackStore?: LeadFeedbackStore;
};

const jobTtlMs = 15 * 60 * 1000;
const getGoogleDiscoveryTimeoutMs = (requestedCount: number) =>
  requestedCount >= 100 ? 32_000 : 20_000;
// Maps is a fallback after Places and OSM. Keep a failed browser attempt from
// holding every regional pass open for the full discovery window.
const googleMapsDiscoveryTimeoutMs = 8_000;
const aiDiscoveryTimeoutMs = 40000;
const osmDiscoveryTimeoutMs = 20000;
const maxCandidatePool = 3000;
const getDiscoveryStallMs = (requestedCount: number) =>
  requestedCount >= 50 ? 45_000 : 20_000;
const getDiscoveryStallLabel = (requestedCount: number) =>
  requestedCount >= 50 ? '45 seconds' : '20 seconds';

const isTimeoutFailure = (error: unknown) =>
  error instanceof Error && /deadline|timed out|timeout/i.test(error.message);

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string) => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const buildNormalizationWarning = (seed: string, error: unknown) => ({
  providerId: 'nominatim',
  providerName: 'Nominatim',
  message:
    error instanceof Error
      ? `${error.message} while normalizing ${seed}`
      : `US location normalization failed for ${seed}`,
});

const rankDiscoveryCandidates = (leads: Lead[]) =>
  [...leads].sort((left, right) => {
    const leftSignal =
      Number(left.source.includes('Google Places')) * 6 +
      Number(left.source.includes('Google Maps')) * 6 +
      Number(left.source.includes('LinkedIn')) * 4 +
      Number(left.hasWebsite) * 5 +
      Number(left.hasPhone) * 5 +
      Number(Boolean(left.address)) * 2 +
      Number(Boolean(left.website && left.mobile)) * 4 +
      (left.sourceScore ?? 0) / 20;
    const rightSignal =
      Number(right.source.includes('Google Places')) * 6 +
      Number(right.source.includes('Google Maps')) * 6 +
      Number(right.source.includes('LinkedIn')) * 4 +
      Number(right.hasWebsite) * 5 +
      Number(right.hasPhone) * 5 +
      Number(Boolean(right.address)) * 2 +
      Number(Boolean(right.website && right.mobile)) * 4 +
      (right.sourceScore ?? 0) / 20;

    return (
      rightSignal - leftSignal ||
      right.confidence - left.confidence ||
      left.name.localeCompare(right.name)
    );
  });

const computeTotals = (leads: Lead[]) => ({
  total: leads.length,
  withEmail: leads.filter((lead) => lead.hasEmail).length,
  withPhone: leads.filter((lead) => lead.hasPhone).length,
  withWebsite: leads.filter((lead) => lead.hasWebsite).length,
});

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

const toResponse = (
  job: SearchJob,
  suppressionKeys: ReadonlySet<string> = new Set(),
): SearchResponse => {
  const qualification = enforcePhoneRequirement(deduplicateLeads(job.leads), job.request);
  const suppression = filterSuppressedLeads(qualification.leads, suppressionKeys);
  const leads = suppression.leads.slice(0, job.request.count);
  const emptyCompletion = job.status === 'complete' && !leads.length && !suppression.suppressedCount;
  const contract = buildSearchResponseContract(normalizeLeadSourceMode(job.request.sourceMode));
  const status = emptyCompletion ? 'failed' : job.status;
  const lastProgressAt = new Date(job.lastProgressAt).toISOString();
  const completedAt = ['complete', 'failed', 'cancelled'].includes(status)
    ? lastProgressAt
    : undefined;
  return {
    ...contract,
    searchId: job.searchId,
    leads,
    ...(job.researchCandidates?.length ? { researchCandidates: job.researchCandidates } : {}),
    meta: {
      ...contract.meta,
      query: job.query,
      locationLabel: job.locationLabel,
      researchDepth: job.request.researchDepth ?? 'verified',
      researchBrief: job.request.researchBrief,
      status,
      execution: buildSearchExecutionContract({
        path: 'durable',
        startedAt: new Date(job.createdAt).toISOString(),
        lastProgressAt,
        ...(completedAt ? { completedAt } : {}),
      }),
      qualitySummary: buildLeadQualitySummary(leads),
      progress: {
        ...job.progress,
        foundCount: leads.length,
        phoneExcludedCount: Math.max(job.progress.phoneExcludedCount ?? 0, qualification.excludedCount),
        suppressedCount: Math.max(job.progress.suppressedCount ?? 0, suppression.suppressedCount),
        currentSource: emptyCompletion ? 'Failed' : job.progress.currentSource,
        estimatedRemaining: Math.max(0, job.request.count - leads.length),
      },
      totals: computeTotals(leads),
      providerWarnings: [
        ...job.providerWarnings,
        ...(qualification.warning ? [qualification.warning] : []),
        ...(suppression.suppressedCount
          ? [{
              providerId: 'workspace-suppression',
              providerName: 'Workspace feedback',
              message: `${suppression.suppressedCount} lead(s) were hidden from this workspace after operator feedback.`,
              severity: 'info' as const,
            }]
          : []),
        ...(emptyCompletion ? [noUsableResultsWarning()] : []),
      ],
    },
  };
};

const cleanupExpiredJobs = (jobs: Map<string, SearchJob>, now: () => number) => {
  const current = now();
  for (const [searchId, job] of jobs.entries()) {
    if (job.expiresAt <= current) {
      jobs.delete(searchId);
    }
  }
};

const dedupeWithCount = (leads: Lead[]) => {
  const deduped = deduplicateLeads(leads);
  return {
    leads: deduped,
    duplicatesRemoved: Math.max(0, leads.length - deduped.length),
  };
};

const appendUniqueWarnings = (job: SearchJob, warnings: ProviderWarning[]) => {
  for (const warning of warnings) {
    if (
      job.providerWarnings.some(
        (item) => item.providerId === warning.providerId && item.message === warning.message,
      )
    ) {
      continue;
    }

    job.providerWarnings.push(warning);
  }
};

const refreshProgress = (job: SearchJob) => {
  job.progress.discovered = job.leads.length;
  job.progress.totalCandidates = job.leads.length;
  job.progress.foundCount = Math.min(job.leads.length, job.request.count);
  job.progress.publicContactsFound = job.leads.filter(
    (lead) => lead.hasEmail || lead.hasPhone,
  ).length;
  job.progress.estimatedRemaining = Math.max(0, job.request.count - job.leads.length);
};

const hasRequestedPhoneCandidates = (job: SearchJob) =>
  job.leads.filter(isPhoneQualifiedLead).length >= job.request.count;

const hasWebsiteDecisionMakerCandidates = (job: SearchJob) =>
  job.leads.some((lead) =>
    Boolean(lead.website?.trim()) &&
    !lead.decisionMakerName &&
    !lead.crawlAttempts,
  );

const trimCandidatePool = (leads: Lead[], requestedCount: number) =>
  rankDiscoveryCandidates(leads).slice(0, Math.min(maxCandidatePool, requestedCount * 5));

const finalizeLeads = (job: SearchJob) => {
  const phoneRequirement = enforcePhoneRequirement(job.leads, job.request);
  job.progress.phoneExcludedCount = phoneRequirement.excludedCount;
  if (phoneRequirement.warning) {
    appendUniqueWarnings(job, [phoneRequirement.warning]);
  }
  job.leads = phoneRequirement.leads.slice(0, job.request.count);
  refreshProgress(job);
};

const finalizeJobStatus = (job: SearchJob) => {
  finalizeLeads(job);

  if (!job.leads.length) {
    appendUniqueWarnings(job, [noUsableResultsWarning()]);
    job.status = 'failed';
    job.progress.currentSource = 'Failed';
  } else {
    job.status = 'complete';
    job.progress.currentSource = 'Complete';
  }

  refreshProgress(job);
};

const upsertLeads = (
  job: SearchJob,
  incoming: Lead[],
  now: () => number,
  countDuplicates = true,
) => {
  const previousCount = job.leads.length;
  const merged = [...job.leads, ...enrichLeads(incoming)];
  const { leads, duplicatesRemoved } = dedupeWithCount(merged);
  if (countDuplicates) {
    job.progress.duplicatesRemoved += duplicatesRemoved;
  }
  job.leads = trimCandidatePool(leads, job.request.count);
  if (job.leads.length > previousCount) {
    job.lastProgressAt = now();
  }
  refreshProgress(job);
};

const runAiDiscovery = async (
  job: SearchJob,
  request: SearchRequest,
  location: NormalizedUsLocation,
  discoverAiLeads: NonNullable<SearchDeps['discoverAiLeads']>,
  now: () => number,
) => {
  job.progress.currentSource = leadSourceModeLabels.ai;

  try {
    const result = await withTimeout(
      discoverAiLeads({
        request,
        location,
        deadlineMs: Date.now() + aiDiscoveryTimeoutMs,
      }),
      aiDiscoveryTimeoutMs,
      'Free AI discovery timed out; any completed public results were preserved.',
    );

    appendUniqueWarnings(job, result.warnings);
    recordProviderCoverage(job.progress, result.coverage);
    job.progress.aiAssistance = result.aiAssistance;
    job.progress.enriched = result.enrichedCount;
    if (result.publicCoverage) {
      job.progress.publicQueriesAttempted = result.publicCoverage.queriesAttempted;
      job.progress.publicProvidersChecked = result.publicCoverage.providersChecked;
      job.progress.publicQueryFamilies = result.publicCoverage.queryFamilies;
      job.progress.publicQueryFamilyCounts = result.publicCoverage.queryFamilyCounts;
    }
    upsertLeads(job, result.leads, now);
    if (result.researchCandidates?.length) {
      job.researchCandidates = [
        ...(job.researchCandidates ?? []),
        ...result.researchCandidates,
      ];
    }
  } catch (error) {
    appendUniqueWarnings(job, [
      {
        providerId: 'ai-mode',
        providerName: 'AI mode',
        message:
          error instanceof Error
            ? error.message
            : 'Free AI discovery failed. No unverified leads were added.',
      },
    ]);
  }

  job.progress.batchesCompleted += 1;
};

const runRegionalDiscovery = async (
  job: SearchJob,
  request: SearchRequest,
  targetLocation: NormalizedUsLocation,
  discoveryLocation: NormalizedUsLocation,
  profile: ReturnType<typeof resolveCategoryProfile>,
  discoverGoogleLeads: NonNullable<SearchDeps['discoverGoogleLeads']>,
  discoverGoogleMapsLeads: SearchDeps['discoverGoogleMapsLeads'] | undefined,
  discoverOsmLeads: NonNullable<SearchDeps['discoverOsmLeads']>,
  enrichWebsiteLead: SearchDeps['enrichWebsiteLead'],
  now: () => number,
) => {
  const candidateTargetCount = getLeadDiscoveryCandidateTarget(request.count);
  const discoveryRequest = {
    ...request,
    count: candidateTargetCount,
  };
  job.progress.currentSource =
    discoveryLocation.mode === 'nationwide' ? 'Nationwide Discovery' : 'Google Places API';
  const queryVariants = buildDiscoveryQueryVariants(
    request.companyType,
    discoveryLocation,
    profile,
  );
  const googlePlacesAvailable =
    discoverGoogleLeads !== googlePlacesProvider || isGooglePlacesConfigured();

  recordProviderCoverage(job.progress, [
    {
      providerId: 'google-places',
      providerName: 'Google Places',
      status: googlePlacesAvailable ? 'configured' : 'not_configured',
      leadCount: 0,
      message: googlePlacesAvailable
        ? 'Configured business listing discovery source.'
        : 'Not configured; free public listing discovery remains available.',
    },
    {
      providerId: 'public-business-listings',
      providerName: 'OpenStreetMap',
      status: 'configured',
      leadCount: 0,
      message: 'Independent free public listing discovery source.',
    },
    {
      providerId: 'google-maps-discovery',
      providerName: 'Public Google Maps Discovery',
      status: discoverGoogleMapsLeads ? 'configured' : 'not_configured',
      leadCount: 0,
      message: discoverGoogleMapsLeads
        ? 'Bounded fallback discovery is available when the primary sources are insufficient.'
        : 'Fallback discovery is not configured for this execution path.',
    },
  ]);

  await Promise.all([
    (async () => {
      if (!googlePlacesAvailable) {
        appendUniqueWarnings(job, [{
          providerId: 'google-places',
          providerName: 'Google Places',
          message:
            'Optional Google Places is not configured. Continuing with free OpenStreetMap and public map discovery.',
          severity: 'info',
        }]);
        return;
      }

      try {
        const googleLeads = await withTimeout(
          typeof discoverGoogleLeads === 'function'
            ? discoverGoogleLeads({
                request: discoveryRequest,
                location: discoveryLocation,
                queryVariants,
                deadlineMs: Date.now() + getGoogleDiscoveryTimeoutMs(request.count),
              })
            : discoverGoogleLeads.fetchLeads({
                rawQuery: request.companyType,
                query: `${request.companyType} in ${discoveryLocation.label}`,
                queryVariants,
                request: {
                  ...discoveryRequest,
                  city: discoveryLocation.label,
                  count: Math.max(discoveryRequest.count, 100),
                },
                location: discoveryLocation,
                deadlineMs: Date.now() + getGoogleDiscoveryTimeoutMs(request.count),
              }),
          getGoogleDiscoveryTimeoutMs(request.count),
          'Google Places discovery timed out before the batch completed',
        );
        const acceptedGoogleLeads = filterLeadsForLocation(googleLeads, targetLocation);
        recordProviderCoverage(job.progress, [
          {
            providerId: 'google-places',
            providerName: 'Google Places',
            status: 'returned',
            leadCount: acceptedGoogleLeads.length,
            message: 'Business listing candidates returned and location-filtered.',
          },
        ]);
        upsertLeads(job, acceptedGoogleLeads, now);
        job.progress.batchesCompleted += 1;
      } catch (error) {
        recordProviderCoverage(job.progress, [
          {
            providerId: 'google-places',
            providerName: 'Google Places',
            status: 'failed',
            leadCount: 0,
            message: error instanceof Error ? error.message : 'Google Places discovery failed.',
          },
        ]);
        appendUniqueWarnings(job, [{
          providerId: 'google-places',
          providerName: 'Google Places',
          message:
            error instanceof Error
              ? error.message
              : 'Google Places discovery failed',
        }]);
      }
    })(),
    (async () => {
      try {
        const osmLeads = await withTimeout(
          discoverOsmLeads({
            request: {
              ...discoveryRequest,
              // OSM adds its own bounded headroom. Avoid multiplying the
              // already-expanded Google discovery target for broad regions.
              count: request.count,
            },
            location: discoveryLocation,
            profile,
            deadlineMs: now() + osmDiscoveryTimeoutMs,
          }),
          osmDiscoveryTimeoutMs,
          'OpenStreetMap discovery timed out before the batch completed',
        );
        const acceptedOsmLeads = filterLeadsForLocation(osmLeads, targetLocation);
        recordProviderCoverage(job.progress, [
          {
            providerId: 'public-business-listings',
            providerName: 'OpenStreetMap',
            status: 'returned',
            leadCount: acceptedOsmLeads.length,
            message: 'Free public listing candidates returned and location-filtered.',
          },
        ]);
        upsertLeads(job, acceptedOsmLeads, now);
        job.progress.batchesCompleted += 1;
      } catch (error) {
        recordProviderCoverage(job.progress, [
          {
            providerId: 'public-business-listings',
            providerName: 'OpenStreetMap',
            status: isTimeoutFailure(error) ? 'partial' : 'failed',
            leadCount: 0,
            message: error instanceof Error ? error.message : 'OpenStreetMap discovery failed.',
          },
        ]);
        appendUniqueWarnings(job, [{
          providerId: 'osm-discovery',
          providerName: 'OpenStreetMap',
          message:
            error instanceof Error ? error.message : 'OSM discovery failed',
        }]);
      }
    })(),
  ]);

  let googleMapsUnavailable = false;

  if (
    job.leads.length < candidateTargetCount &&
    !hasRequestedPhoneCandidates(job) &&
    discoverGoogleMapsLeads
  ) {
    try {
      const remainingCount = candidateTargetCount - job.leads.length;
      const googleMapsRequestCount = Math.min(Math.max(remainingCount, 15), 60);
      const googleMapsLeads = await withTimeout(
        discoverGoogleMapsLeads({
          request: {
            ...request,
            count: googleMapsRequestCount,
          },
          location: discoveryLocation,
          queryVariants,
          maxResults: googleMapsRequestCount,
          queryLimit: getResearchDepthConfig(request.researchDepth).googleMapsQueryLimit,
          deadlineMs: Date.now() + googleMapsDiscoveryTimeoutMs,
        }),
        googleMapsDiscoveryTimeoutMs,
        'Google Maps discovery timed out before the batch completed',
      );
      const acceptedGoogleMapsLeads = filterLeadsForLocation(googleMapsLeads, targetLocation);
      recordProviderCoverage(job.progress, [
        {
          providerId: 'google-maps-discovery',
          providerName: 'Public Google Maps Discovery',
          status: 'returned',
          leadCount: acceptedGoogleMapsLeads.length,
          message: 'Bounded fallback discovery returned candidates.',
        },
      ]);
      upsertLeads(job, acceptedGoogleMapsLeads, now);
      job.progress.batchesCompleted += 1;
      job.progress.currentSource = 'Google Maps API';
    } catch (error) {
      recordProviderCoverage(job.progress, [
        {
          providerId: 'google-maps-discovery',
          providerName: 'Public Google Maps Discovery',
          status: 'failed',
          leadCount: 0,
          message: error instanceof Error ? error.message : 'Public Google Maps discovery failed.',
        },
      ]);
      googleMapsUnavailable = true;
      appendUniqueWarnings(job, [{
        providerId: 'google-maps',
        providerName: 'Google Maps',
        message: formatGoogleMapsFailure(error),
      }]);
    }
  }

  if (
    enrichWebsiteLead &&
    (!hasRequestedPhoneCandidates(job) || hasWebsiteDecisionMakerCandidates(job))
  ) {
    const websiteResult = await enrichWebsiteCandidates({
      leads: job.leads,
      enrichLead: enrichWebsiteLead,
      deadlineMs: now() + 8_000,
      includeDecisionMakerNames: true,
      now,
    });
    appendUniqueWarnings(job, websiteResult.warnings);
    recordProviderCoverage(job.progress, [
      {
        providerId: 'public-website-enrichment',
        providerName: 'Public Website Enrichment',
        status: websiteResult.leads.length ? 'returned' : websiteResult.candidateCount ? 'failed' : 'configured',
        leadCount: websiteResult.leads.length,
        message: websiteResult.candidateCount
          ? `Checked ${websiteResult.attemptedCount} public website candidate(s) for phone and decision-maker evidence within the bounded recovery window.`
          : 'No public website candidates required phone or decision-maker recovery.',
      },
    ]);
    if (websiteResult.leads.length) {
      upsertLeads(job, websiteResult.leads, now, false);
      job.progress.enriched += websiteResult.attemptedCount;
    }
  }

  return {
    googleMapsUnavailable,
  };
};

export const createSearchService = (deps: SearchDeps = {}): SearchService => {
  const jobs = new Map<string, SearchJob>();
  const feedbackStore = deps.feedbackStore ?? createLeadFeedbackStore();
  const normalizeLocation = deps.normalizeLocation ?? normalizeUsLocation;
  const discoverGoogleLeads = deps.discoverGoogleLeads ?? googlePlacesProvider;
  const discoverGoogleMapsLeads =
    deps.discoverGoogleMapsLeads ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromGoogleMaps);
  const discoverAiLeads = deps.discoverAiLeads ?? discoverUsLeadsFromAiMode;
  const enrichWebsiteLead =
    deps.enrichWebsiteLead ??
    (process.env.NODE_ENV === 'test' ? undefined : enrichLeadFromWebsite);
  const discoverOsmLeads = deps.discoverOsmLeads ?? discoverUsLeadsFromOsm;
  const now = deps.now ?? Date.now;
  const idFactory = deps.idFactory ?? randomUUID;
  const canAccessJob = (job: SearchJob, context?: SearchAccessContext) =>
    !context?.ownerId || job.ownerId === context.ownerId;
  const schedule =
    deps.schedule ??
    ((task: () => Promise<void>) => {
      setTimeout(() => {
        void task();
      }, 0);
    });

  const renderResponse = async (job: SearchJob, ownerId?: string) => {
    const suppressionKeys = ownerId
      ? await feedbackStore.getSuppressionKeys(ownerId)
      : new Set<string>();
    return toResponse(job, suppressionKeys);
  };

  const markFailed = (job: SearchJob, warning: ProviderWarning) => {
    job.status = 'failed';
    job.providerWarnings.push(warning);
    refreshProgress(job);
  };

  const isCurrentRun = (job: SearchJob, executionToken: string) =>
    job.executionToken === executionToken && !job.cancelRequested && job.status !== 'cancelled';

  const processJob = async (job: SearchJob, executionToken: string) => {
    if (!isCurrentRun(job, executionToken)) {
      return;
    }

    job.status = 'discovering';
    job.progress.currentSource = 'Nominatim';
    const sourceMode: LeadSourceMode = normalizeLeadSourceMode(job.request.sourceMode);
    if (job.request.sourceMode !== sourceMode) {
      job.request = { ...job.request, sourceMode };
    }
    const guardedDiscoverGoogleMapsLeads = discoverGoogleMapsLeads
      ? async (args: Parameters<NonNullable<SearchDeps['discoverGoogleMapsLeads']>>[0]) => {
          if (job.googleMapsUnavailable) {
            return [];
          }

          return discoverGoogleMapsLeads(args);
        }
      : undefined;

    let location: NormalizedUsLocation;
    try {
      location = await normalizeLocation(job.request.city);
      job.locationLabel = location.label;
      job.query =
        location.mode === 'nationwide'
          ? `${job.request.companyType} in United States`
          : `${job.request.companyType} in ${job.locationLabel}`;
      job.providerWarnings.push(...location.warnings);
    } catch (error) {
      if (!isCurrentRun(job, executionToken)) return;
      markFailed(job, {
        providerId: 'nominatim',
        providerName: 'Nominatim',
        message:
          error instanceof Error ? error.message : 'US location normalization failed',
      });
      return;
    }

    if (!isCurrentRun(job, executionToken)) return;

    job.progress.currentSource = leadSourceModeLabels[sourceMode];

    if (sourceMode === 'ai') {
      await runAiDiscovery(job, job.request, location, discoverAiLeads, now);
      if (!isCurrentRun(job, executionToken)) return;
      finalizeJobStatus(job);
      return;
    }

    const profile = resolveCategoryProfile(job.request.companyType);
    job.providerWarnings.push(...profile.warnings);
    const candidateTargetCount = getLeadDiscoveryCandidateTarget(job.request.count);

    const discoverySeeds = buildDiscoverySeeds(location);

    const discoveryLocations = [location];
    const normalizedSeeds = await Promise.all(
      discoverySeeds.map(async (seed) => {
        try {
          return await normalizeLocation(seed);
        } catch (error) {
          job.providerWarnings.push(buildNormalizationWarning(seed, error));
          return null;
        }
      }),
    );

    discoveryLocations.push(
      ...normalizedSeeds.filter((entry): entry is NormalizedUsLocation => Boolean(entry)),
    );

    for (const regionalLocation of discoveryLocations) {
      if (!isCurrentRun(job, executionToken)) return;
      if (job.leads.length >= candidateTargetCount || hasRequestedPhoneCandidates(job)) {
        break;
      }

      if (
        job.leads.length < candidateTargetCount &&
        !hasRequestedPhoneCandidates(job) &&
        now() - job.lastProgressAt >= getDiscoveryStallMs(job.request.count)
      ) {
        appendUniqueWarnings(job, [{
          providerId: 'discovery-limit',
          providerName: 'Discovery',
          message:
            `No new businesses were returned after ${getDiscoveryStallLabel(job.request.count)}. Search stopped after verifying the available results.`,
        }]);
        break;
      }

      const foundCountBeforeRegional = job.leads.length;
      const regionalResult = await runRegionalDiscovery(
        job,
        job.request,
        location,
        regionalLocation,
        profile,
        discoverGoogleLeads,
        guardedDiscoverGoogleMapsLeads,
        discoverOsmLeads,
        enrichWebsiteLead,
        now,
      );

      if (!isCurrentRun(job, executionToken)) return;

      if (regionalResult.googleMapsUnavailable) {
        job.googleMapsUnavailable = true;
      }

      if (
        job.googleMapsUnavailable &&
        job.leads.length === foundCountBeforeRegional
      ) {
        appendUniqueWarnings(job, [{
          providerId: 'discovery-limit',
          providerName: 'Discovery',
          message:
            'Google Maps fallback was unavailable and other sources returned no new businesses. Search completed with the available results.',
        }]);
        break;
      }

      if (
        job.leads.length < candidateTargetCount &&
        !hasRequestedPhoneCandidates(job) &&
        now() - job.lastProgressAt >= getDiscoveryStallMs(job.request.count)
      ) {
        appendUniqueWarnings(job, [{
          providerId: 'discovery-limit',
          providerName: 'Discovery',
          message:
            `No new businesses were returned after ${getDiscoveryStallLabel(job.request.count)}. Search stopped after verifying the available results.`,
        }]);
        break;
      }
    }

    if (!isCurrentRun(job, executionToken)) return;

    finalizeJobStatus(job);
  };

  return {
    async startSearch(request, context) {
      const startedAt = now();
      cleanupExpiredJobs(jobs, () => startedAt);

      const normalizedRequest: SearchRequest = {
        ...request,
        sourceMode: normalizeLeadSourceMode(request.sourceMode),
        phoneRequired: true,
        researchDepth: request.researchDepth ?? 'verified',
      };
      const idempotencyKey = normalizeIdempotencyKey(context?.idempotencyKey);
      const requestFingerprint = createSearchRequestFingerprint(normalizedRequest);

      if (idempotencyKey) {
        const existingJob = [...jobs.values()].find(
          (candidate) => candidate.idempotencyKey === idempotencyKey,
        );
        if (existingJob) {
          if (existingJob.ownerId !== context?.ownerId) {
            throw new SearchIdempotencyConflictError();
          }

          if (existingJob.requestFingerprint !== requestFingerprint) {
            throw new SearchIdempotencyConflictError();
          }

          return renderResponse(existingJob, context?.ownerId);
        }
      }

      const searchId = idFactory();
      const job: SearchJob = {
        searchId,
        ownerId: context?.ownerId,
        idempotencyKey,
        requestFingerprint,
        request: normalizedRequest,
        leads: [],
        locationLabel: normalizedRequest.city.trim(),
        query: `${normalizedRequest.companyType} in ${normalizedRequest.city.trim()}`,
        status: 'queued',
        progress: createProgress(normalizedRequest.count),
        providerWarnings: [],
        researchCandidates: [],
        expiresAt: startedAt + jobTtlMs,
        createdAt: startedAt,
        lastProgressAt: startedAt,
        executionToken: randomUUID(),
      };

      jobs.set(searchId, job);
      const executionToken = job.executionToken;
      schedule(async () => {
        await processJob(job, executionToken);
      });

      return renderResponse(job, context?.ownerId);
    },

    async getSearch(searchId, context) {
      cleanupExpiredJobs(jobs, now);
      const job = jobs.get(searchId);
      return job && canAccessJob(job, context)
        ? renderResponse(job, context?.ownerId)
        : null;
    },

    async cancelSearch(searchId, context) {
      cleanupExpiredJobs(jobs, now);
      const job = jobs.get(searchId);
      if (!job || !canAccessJob(job, context)) return null;

      if (!['complete', 'failed', 'cancelled'].includes(job.status)) {
        job.cancelRequested = true;
        job.status = 'cancelled';
        job.progress.currentSource = 'Cancelled';
        job.lastProgressAt = now();
        job.executionToken = randomUUID();
      }

      return renderResponse(job, context?.ownerId);
    },

    async resumeSearch(searchId, context) {
      cleanupExpiredJobs(jobs, now);
      const job = jobs.get(searchId);
      if (!job || !canAccessJob(job, context)) return null;

      if (job.status === 'cancelled') {
        job.cancelRequested = false;
        job.status = 'discovering';
        job.progress.currentSource = 'Resuming research';
        job.lastProgressAt = now();
        job.executionToken = randomUUID();
        const executionToken = job.executionToken;
        schedule(async () => {
          await processJob(job, executionToken);
        });
      }

      return renderResponse(job, context?.ownerId);
    },

    async reverifySearch(searchId, context) {
      cleanupExpiredJobs(jobs, now);
      const job = jobs.get(searchId);
      if (!job || !canAccessJob(job, context)) return null;

      job.leads = reverifyLeads(job.leads);
      appendUniqueWarnings(job, [
        {
          providerId: 'reverification',
          providerName: 'Deterministic verification',
          message:
            'Reverification refreshed public phone, email, website, evidence, and scores without refetching provider pages.',
          severity: 'info',
        },
      ]);
      refreshProgress(job);
      job.lastProgressAt = now();
      return renderResponse(job, context?.ownerId);
    },

    async recordFeedback(searchId, feedback, context) {
      if (!context?.ownerId) {
        return null;
      }

      cleanupExpiredJobs(jobs, now);
      const job = jobs.get(searchId);
      if (!job || !canAccessJob(job, context)) return null;

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

      return renderResponse(job, context.ownerId);
    },
  };
};

export const searchService = createSearchService();
