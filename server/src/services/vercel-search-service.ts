import { randomUUID } from 'node:crypto';

import type { Lead } from '../types/lead';
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
import { discoverUsLeadsFromOsm } from './osm-discovery';
import { formatGoogleMapsFailure } from './google-maps-discovery';
import {
  discoverUsLeadsFromLinkedinSearch,
  type LinkedInDiscoveryResult,
} from './linkedin-search';
import { enrichLinkedinLeadsWithPublicContacts } from './linkedin-contact-enrichment';
import { enrichLeadFromWebsite } from './website-enrichment';
import { enrichWebsiteCandidates, type WebsiteLeadEnricher } from './business-website-enrichment';
import {
  discoverUsLeadsFromAiMode,
  type AiDiscoveryResult,
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
import { resolveCategoryProfile } from './us-category-mapping';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { buildDiscoverySeeds } from './discovery-seeds';
import { getResearchDepthConfig } from './research-depth';
import { getLeadDiscoveryCandidateTarget } from './lead-discovery-budget';
import { createResearchQueue, type ResearchQueue } from './research-queue';
import { reverifyLeads } from './research-reverification';
import { noUsableResultsWarning } from './search-finalization';
import { bridgeLinkedInWithPublicListings } from './public-entity-matching';
import { recordProviderCoverage } from './provider-coverage';
import { expandQueryWithGemini } from '../providers/gemini';
import { runGeminiQueryAssistance } from './gemini-query-assistance';
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
  discoverLinkedinLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    queryHints?: string[];
    deadlineMs?: number;
  }) => Promise<LinkedInDiscoveryResult>;
  discoverAiLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    deadlineMs?: number;
  }) => Promise<AiDiscoveryResult>;
  enrichLinkedinLeads?: typeof enrichLinkedinLeadsWithPublicContacts;
  expandQuery?: typeof expandQueryWithGemini;
  discoverOsmLeads?: (args: {
    request: { companyType: string; count: number };
    location: NormalizedUsLocation;
    profile: ReturnType<typeof resolveCategoryProfile>;
    deadlineMs?: number;
  }) => Promise<Lead[]>;
  discoverLinkedinListings?: NonNullable<VercelSearchServiceDeps['discoverOsmLeads']>;
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
  // Keep Playwright and Chromium out of LinkedIn serverless cold starts.
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
const getLinkedinProfileDiscoveryWindowMs = (requestedCount: number) =>
  requestedCount >= 50 ? 30_000 : 20_000;
const getLinkedinContactEnrichmentWindowMs = (requestedCount: number) =>
  requestedCount >= 50 ? 24_000 : 14_000;
const getLinkedinContactEnrichmentBatchSize = (requestedCount: number) =>
  requestedCount >= 100 ? 18 : 12;
const getAiDiscoveryWindowMs = (requestedCount: number) =>
  requestedCount >= 50 ? 36_000 : 30_000;
const getMaxTickDurationMs = (requestedCount: number) =>
  requestedCount >= 50 ? 45_000 : 30_000;
const processingLeaseMs = 70_000;

const isTimeoutFailure = (error: unknown) =>
  error instanceof Error && /deadline|timed out|timeout/i.test(error.message);

const isVercelRuntime = () =>
  process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);

const withNow = () => Date.now();

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

const trimCandidatePool = (leads: Lead[], requestedCount: number) =>
  rankDiscoveryCandidates(leads).slice(0, Math.min(maxCandidatePool, requestedCount * 5));

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
  job.leads = trimCandidatePool(leads, job.request.count);
  if (job.leads.length > previousCount) {
    job.lastProgressAt = now();
  }
  refreshProgress(job);
};

const runLinkedinDiscovery = async (
  job: SearchJobRecord,
  request: SearchRequest,
  location: NormalizedUsLocation,
  discoverLinkedinLeads: NonNullable<VercelSearchServiceDeps['discoverLinkedinLeads']>,
  discoverPublicListings: VercelSearchServiceDeps['discoverLinkedinListings'],
  expandQuery: NonNullable<VercelSearchServiceDeps['expandQuery']>,
  now: () => number,
) => {
  job.progress.currentSource = leadSourceModeLabels.linkedin;
  recordProviderCoverage(job.progress, [
    {
      providerId: 'linkedin-public-search',
      providerName: 'Public LinkedIn Search',
      status: 'configured',
      leadCount: 0,
      message: 'Public search engines only; private profiles and authenticated sessions are not accessed.',
    },
    {
      providerId: 'public-business-listings',
      providerName: 'Public Business Listings',
      status: discoverPublicListings ? 'configured' : 'not_configured',
      leadCount: 0,
      message: discoverPublicListings
        ? 'Free public listings are used for organization and phone corroboration.'
        : 'No public listing fallback was configured for this execution path.',
    },
  ]);

  const discoveryDeadlineMs = now() + getLinkedinProfileDiscoveryWindowMs(request.count);
  let publicListingsFailed = false;
  let publicListingsTimedOut = false;
  const assistancePromise = runGeminiQueryAssistance({
    request,
    locationLabel: location.label,
    seedHints: request.researchBrief?.trim() ? [request.researchBrief.trim()] : [],
    deadlineMs: discoveryDeadlineMs,
    expandQuery,
  });
  const linkedinResultPromise = assistancePromise.then((assistance) => {
    job.progress.aiAssistance = assistance.aiAssistance;
    recordProviderCoverage(job.progress, [assistance.coverage]);
    if (assistance.warning) appendWarningOnce(job, assistance.warning);
    return discoverLinkedinLeads({
      request,
      location,
      queryHints: assistance.queryHints,
      deadlineMs: discoveryDeadlineMs,
    });
  });
  const publicListingPromise = discoverPublicListings
    ? discoverPublicListings({
        request: {
          companyType: request.companyType,
          count: request.count,
        },
        location,
        profile: resolveCategoryProfile(request.companyType),
        deadlineMs: Math.min(
          discoveryDeadlineMs,
          now() + getGooglePlacesTimeoutMs(request.count),
        ),
      }).catch((error): Lead[] => {
        publicListingsFailed = true;
        publicListingsTimedOut = isTimeoutFailure(error);
        appendWarningOnce(job, {
          providerId: 'public-business-listings',
          providerName: 'Public Business Listings',
          message:
            error instanceof Error
              ? `${error.message} LinkedIn profiles were preserved.`
              : 'Public business-listing discovery failed. LinkedIn profiles were preserved.',
          severity: 'warning',
        });
        return [];
      })
    : Promise.resolve([] as Lead[]);

  const [linkedinResult, publicListingLeads] = await Promise.all([
    linkedinResultPromise,
    publicListingPromise,
  ]);

  for (const warning of linkedinResult.warnings) {
    appendWarningOnce(job, warning);
  }
  recordProviderCoverage(job.progress, [
    {
      providerId: 'linkedin-public-search',
      providerName: 'Public LinkedIn Search',
      status: linkedinResult.blocked ? 'failed' : 'returned',
      leadCount: linkedinResult.leads.length,
      message: linkedinResult.blocked
        ? 'Public search providers were blocked or rate-limited.'
        : 'Public profile discovery returned candidates.',
    },
    {
      providerId: 'public-business-listings',
      providerName: 'Public Business Listings',
      status: publicListingsFailed
        ? publicListingsTimedOut
          ? 'partial'
          : 'failed'
        : publicListingLeads.length
          ? 'returned'
          : discoverPublicListings
            ? 'returned'
            : 'not_configured',
      leadCount: publicListingLeads.length,
      message: publicListingsFailed
        ? 'Public listing discovery failed; LinkedIn profiles were preserved.'
        : `Free public listing provider returned ${publicListingLeads.length} candidate(s).`,
    },
  ]);

  if (linkedinResult.coverage) {
    job.progress.publicQueriesAttempted = linkedinResult.coverage.queriesAttempted;
    job.progress.publicProvidersChecked = linkedinResult.coverage.providersChecked;
    job.progress.publicQueryFamilies = linkedinResult.coverage.queryFamilies;
    job.progress.publicQueryFamilyCounts = linkedinResult.coverage.queryFamilyCounts;
  }

  if (!linkedinResult.leads.length) {
    if (linkedinResult.blocked) {
      appendWarningOnce(job, {
        providerId: 'linkedin-search',
        providerName: 'LinkedIn',
        message:
          'LinkedIn search providers were blocked or rate-limited, so no public profiles were returned.',
      });
    }

    return;
  }

  if (publicListingLeads.length) {
    appendWarningOnce(job, {
      providerId: 'public-business-listings',
      providerName: 'Public Business Listings',
      message:
        `Checked ${publicListingLeads.length} free public listings to corroborate LinkedIn organizations and phone evidence.`,
      severity: 'info',
    });
  }

  mergeLeads(
    job,
    bridgeLinkedInWithPublicListings(linkedinResult.leads, publicListingLeads),
    now,
  );
  job.progress.batchesCompleted += 1;
};

const runLinkedinEnrichment = async (
  job: SearchJobRecord,
  request: SearchRequest,
  location: NormalizedUsLocation,
  enrichLinkedinLeads: NonNullable<VercelSearchServiceDeps['enrichLinkedinLeads']>,
  now: () => number,
) => {
  job.progress.currentSource = 'Public Contact Enrichment';
  job.progress.discovered = job.leads.length;
  job.progress.totalCandidates = job.leads.length;

  const enrichmentQueue =
    job.enrichmentQueue?.length ? job.enrichmentQueue : job.leads.map((lead) => lead.id);
  const enrichmentCursor = Math.min(
    enrichmentQueue.length,
    Math.max(0, job.enrichmentCursor ?? 0),
  );
  const batchIds = enrichmentQueue.slice(
    enrichmentCursor,
    enrichmentCursor + getLinkedinContactEnrichmentBatchSize(request.count),
  );
  const batch = batchIds
    .map((id) => job.leads.find((lead) => lead.id === id))
    .filter((lead): lead is Lead => Boolean(lead));

  job.enrichmentQueue = enrichmentQueue;

  if (!batch.length) {
    job.enrichmentCursor = enrichmentCursor + batchIds.length;
    return job.enrichmentCursor >= enrichmentQueue.length;
  }

  const contactResult = await enrichLinkedinLeads({
    leads: batch,
    request,
    location,
    deadlineMs: now() + getLinkedinContactEnrichmentWindowMs(request.count),
    onProgress: (completed) => {
      job.progress.enriched = Math.min(
        enrichmentQueue.length,
        enrichmentCursor + completed,
      );
      job.updatedAt = now();
    },
  });

  for (const warning of contactResult.warnings) {
    appendWarningOnce(job, warning);
  }
  recordProviderCoverage(job.progress, [
    {
      providerId: 'public-website-enrichment',
      providerName: 'Public Website Enrichment',
      status: 'returned',
      leadCount: contactResult.enrichedCount,
      message: 'Public business websites were checked for published contact details.',
    },
  ]);

  job.progress.enriched = contactResult.enrichedCount;
  mergeLeads(job, contactResult.leads, now, false);

  job.enrichmentCursor = enrichmentCursor + batchIds.length;
  job.progress.enriched = Math.min(
    enrichmentQueue.length,
    job.enrichmentCursor,
  );

  return job.enrichmentCursor >= enrichmentQueue.length;
};

const runAiDiscovery = async (
  job: SearchJobRecord,
  request: SearchRequest,
  location: NormalizedUsLocation,
  discoverAiLeads: NonNullable<VercelSearchServiceDeps['discoverAiLeads']>,
  now: () => number,
) => {
  job.progress.currentSource = leadSourceModeLabels.ai;

  const result = await discoverAiLeads({
    request,
    location,
    deadlineMs: now() + getAiDiscoveryWindowMs(request.count),
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
  job.progress.batchesCompleted += 1;
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
  let osmFailed = false;
  const providerCoverage: ProviderCoverage[] = [
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
        ? 'Bounded fallback discovery is available when primary sources are insufficient.'
        : 'Fallback discovery is not configured for this execution path.',
    },
  ];
  const updateCoverage = (entry: ProviderCoverage) => {
    const current = providerCoverage.find((item) => item.providerId === entry.providerId);
    if (!current) {
      providerCoverage.push(entry);
      return;
    }

    current.status = entry.status;
    current.leadCount += Math.max(0, entry.leadCount);
    current.message = entry.message ?? current.message;
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
      return await googlePlaces.fetchLeads({
        rawQuery: request.companyType,
        query,
        queryVariants,
        request: googleRequest,
        location: discoveryLocation,
        deadlineMs: googlePlacesDeadlineMs,
      });
    } catch (error) {
      googlePlacesFailed = true;
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
      return await discoverOsmLeads({
        request: googleRequest,
        location: discoveryLocation,
        profile,
        deadlineMs,
      });
    } catch (error) {
      osmFailed = true;
      warnings.push({
        providerId: 'osm-discovery',
        providerName: 'OpenStreetMap',
        message:
          error instanceof Error ? error.message : 'OpenStreetMap discovery failed',
      });
      return [] as Lead[];
    }
  })();

  const [googleLeads, osmLeads] = await Promise.all([googleLeadsPromise, osmLeadsPromise]);

  updateCoverage({
    providerId: 'google-places',
    providerName: 'Google Places',
    status: googlePlacesFailed
      ? 'failed'
      : googleLeads.length
        ? 'returned'
        : googlePlacesAvailable
          ? 'returned'
          : 'not_configured',
    leadCount: googleLeads.length,
    message: googleLeads.length
      ? 'Business listing candidates returned.'
      : googlePlacesAvailable
        ? 'Provider responded without candidates.'
        : 'Provider was not configured.',
  });
  updateCoverage({
    providerId: 'public-business-listings',
    providerName: 'OpenStreetMap',
    status: osmFailed ? 'failed' : 'returned',
    leadCount: osmLeads.length,
    message: `Free public listing provider returned ${osmLeads.length} candidate(s).`,
  });

  if (!googleLeads.length && !osmLeads.length) {
    warnings.push({
      providerId: 'discovery',
      providerName: 'Discovery',
      message: `No discovery candidates returned for ${discoveryLocation.label}`,
    });
  }

  const acceptedDiscoveryLeads = filterLeadsForLocation([...googleLeads, ...osmLeads], targetLocation);
  let googleMapsLeads: Lead[] = [];
  let googleMapsUnavailable = false;

  if (
    acceptedDiscoveryLeads.length < candidateTargetCount &&
    acceptedDiscoveryLeads.filter(isPhoneQualifiedLead).length < request.count &&
    discoverGoogleMapsLeads
  ) {
    try {
      const remainingCount = candidateTargetCount - acceptedDiscoveryLeads.length;
      const googleMapsRequestCount = Math.min(Math.max(remainingCount, 15), 60);
      const googleMapsDeadlineMs = Math.min(
        deadlineMs,
        now() + getGoogleMapsTimeoutMs(request.count),
      );
      googleMapsLeads = await discoverGoogleMapsLeads({
        request: {
          ...request,
          count: googleMapsRequestCount,
        },
        location: discoveryLocation,
        queryVariants,
        maxResults: googleMapsRequestCount,
        queryLimit: getResearchDepthConfig(request.researchDepth).googleMapsQueryLimit,
        deadlineMs: googleMapsDeadlineMs,
      });
      updateCoverage({
        providerId: 'google-maps-discovery',
        providerName: 'Public Google Maps Discovery',
        status: 'returned',
        leadCount: googleMapsLeads.length,
        message: `Bounded fallback discovery returned ${googleMapsLeads.length} candidate(s).`,
      });
    } catch (error) {
      googleMapsUnavailable = true;
      updateCoverage({
        providerId: 'google-maps-discovery',
        providerName: 'Public Google Maps Discovery',
        status: 'failed',
        leadCount: 0,
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
    leads: filterLeadsForLocation([...acceptedDiscoveryLeads, ...googleMapsLeads], targetLocation),
    warnings,
    googleMapsUnavailable,
    providerCoverage,
  };
};

const tickJob = async (
  job: SearchJobRecord,
  store: ReturnType<typeof createSearchJobStore>,
  deps: Required<Pick<VercelSearchServiceDeps, 'googlePlaces' | 'normalizeLocation' | 'discoverOsmLeads' | 'now' | 'expandQuery'>> &
    Pick<
      VercelSearchServiceDeps,
      | 'discoverGoogleMapsLeads'
      | 'discoverLinkedinLeads'
      | 'discoverLinkedinListings'
      | 'discoverAiLeads'
      | 'enrichLinkedinLeads'
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

    try {
      job.status = 'discovering';
      job.progress.currentSource = leadSourceModeLabels.ai;
      job.updatedAt = deps.now();
      await store.upsert(job);
      await runAiDiscovery(job, job.request, targetLocation, discoverAiLeads, deps.now);
    } catch (error) {
      appendWarningOnce(job, {
        providerId: 'ai-mode',
        providerName: 'AI mode',
        message:
          error instanceof Error
            ? error.message
            : 'Free AI discovery failed. No unverified leads were added.',
      });
    }

    job.discoveryComplete = true;
    finalizeJobStatus(job);
    job.updatedAt = withNow();
    await store.upsert(job);
    return job;
  }

  if (sourceMode === 'linkedin') {
    const discoverLinkedinLeads =
      deps.discoverLinkedinLeads ??
      (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromLinkedinSearch);

    if (!discoverLinkedinLeads) {
      appendWarningOnce(job, {
        providerId: 'linkedin-search',
        providerName: 'LinkedIn',
        message: 'LinkedIn discovery is not configured for this environment.',
      });
      job.status = 'failed';
      job.progress.currentSource = 'LinkedIn';
      job.updatedAt = withNow();
      await store.upsert(job);
      return job;
    }

    let linkedinEnrichmentComplete = true;

    try {
      if (job.status !== 'enriching') {
        job.status = 'discovering';
        job.progress.currentSource = leadSourceModeLabels.linkedin;
        job.updatedAt = deps.now();
        // Persist the phase before the network work so overlapping polls see a
        // truthful in-progress snapshot instead of starting from "queued".
        await store.upsert(job);
      }

      if (job.status === 'enriching' && deps.enrichLinkedinLeads && job.leads.length) {
        linkedinEnrichmentComplete = await runLinkedinEnrichment(
          job,
          job.request,
          targetLocation,
          deps.enrichLinkedinLeads,
          deps.now,
        );
      } else {
        await runLinkedinDiscovery(
          job,
          job.request,
          targetLocation,
          discoverLinkedinLeads,
          deps.discoverLinkedinListings,
          deps.expandQuery,
          deps.now,
        );

        if (deps.enrichLinkedinLeads && job.leads.length) {
          job.enrichmentQueue = job.leads.map((lead) => lead.id);
          job.enrichmentCursor = 0;
          job.status = 'enriching';
          job.progress.currentSource = 'Public Contact Enrichment';
          job.updatedAt = withNow();
          await store.upsert(job);
          return job;
        }
      }
    } catch (error) {
      appendWarningOnce(job, {
        providerId: 'linkedin-search',
        providerName: 'LinkedIn',
        message:
          error instanceof Error
            ? error.message
            : 'LinkedIn discovery failed',
      });
      job.status = 'failed';
      job.progress.currentSource = 'LinkedIn';
      job.updatedAt = withNow();
      await store.upsert(job);
      return job;
    }

    if (!linkedinEnrichmentComplete) {
      job.status = 'enriching';
      job.progress.currentSource = 'Public Contact Enrichment';
      job.updatedAt = withNow();
      await store.upsert(job);
      return job;
    }

    job.discoveryComplete = true;
    finalizeJobStatus(job);
    job.updatedAt = withNow();
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
      const { leads, warnings, googleMapsUnavailable, providerCoverage } = await discoverRegionLeads(
        job.request,
        targetLocation,
        regionalLocation,
        deps.googlePlaces,
        discoverGoogleMapsForSearch,
        deps.discoverOsmLeads,
        deps.now,
        resolveCategoryProfile(job.request.companyType),
        deps.now() + maxTickDurationMs,
      );

      job.providerWarnings.push(...warnings);
      recordProviderCoverage(job.progress, providerCoverage);
      mergeLeads(job, leads, deps.now);

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
          status: websiteResult.leads.length
            ? 'returned'
            : websiteResult.candidateCount
              ? 'failed'
              : 'configured',
          leadCount: websiteResult.leads.length,
          message: websiteResult.candidateCount
            ? `Checked ${websiteResult.attemptedCount} public website candidate(s) for phone and decision-maker evidence within the bounded recovery window.`
            : 'No public website candidates required phone or decision-maker recovery.',
        }]);
        if (websiteResult.leads.length) {
          mergeLeads(job, websiteResult.leads, deps.now, false);
          job.progress.enriched += websiteResult.attemptedCount;
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
  const discoverLinkedinLeads =
    deps.discoverLinkedinLeads ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromLinkedinSearch);
  const expandQuery = deps.expandQuery ?? expandQueryWithGemini;
  const discoverAiLeads = deps.discoverAiLeads ?? discoverUsLeadsFromAiMode;
  const enrichLinkedinLeads =
    deps.enrichLinkedinLeads ??
    (deps.discoverLinkedinLeads ? undefined : enrichLinkedinLeadsWithPublicContacts);
  const enrichWebsiteLead =
    deps.enrichWebsiteLead ??
    (process.env.NODE_ENV === 'test' ? undefined : enrichLeadFromWebsite);
  const discoverOsm = deps.discoverOsmLeads ?? discoverUsLeadsFromOsm;
  const discoverLinkedinListings =
    deps.discoverLinkedinListings ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverOsm);
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
      discoverLinkedinLeads,
      discoverLinkedinListings,
      discoverAiLeads,
      enrichLinkedinLeads,
      enrichWebsiteLead,
      expandQuery,
      discoverOsmLeads: discoverOsm,
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
