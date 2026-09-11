import { randomUUID } from 'node:crypto';

import type { Lead, ResearchCandidate, ReviewCandidate } from '../types/lead';
import type {
  ProviderCoverage,
  ProviderWarning,
  SearchRequest,
  SearchResponse,
} from '../types/search';
import type { NormalizedUsLocation } from './us-location';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead } from './lead-validation';
import {
  discoverUsLeadsFromLinkedinSearch,
  type LinkedInDiscoveryResult,
} from './linkedin-search';
import { enrichLinkedinLeadsWithPublicContacts } from './linkedin-contact-enrichment';
import {
  discoverUsLeadsFromOsm,
  discoverUsLeadsFromOsmBatch,
  type OsmDiscoveryBatchResult,
} from './osm-discovery';
import { normalizeUsLocation } from './us-location';
import { resolveCategoryProfile } from './us-category-mapping';
import { freeAiModePolicy, salesProviderAudits } from '../providers/sales-intelligence';
import { googlePlacesProvider, isGooglePlacesConfigured } from '../providers/google-places';
import {
  getGeminiApiKeyCount,
  getGeminiPoolHealth,
  isGeminiRateLimited,
  isGeminiLeadDiscoveryEnabled,
} from '../providers/gemini';
import {
  discoverGeminiResearch,
  type GeminiResearchDiscovery,
} from './gemini-lead-discovery';
import { enforcePhoneRequirement, isPhoneQualifiedLead } from './phone-requirement';
import { normalizeContactPhone } from './contact-evidence';
import { noUsableResultsWarning } from './search-finalization';
import { mergeLinkedInWithPublicListingsWithDiagnostics } from './public-entity-matching';
import { getLeadDiscoveryCandidateTarget } from './lead-discovery-budget';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { buildDiscoverySeeds } from './discovery-seeds';
import {
  buildSearchExecutionContract,
  buildSearchResponseContract,
} from '../../../shared/search-contract';
import { getPublicProviderPriority } from '../../../shared/source-priority';
import { normalizeLeadSourceMode } from './search-source-mode';
import { buildLeadQualitySummary } from './quality-summary';
import { filterLeadsForLocation } from './location-acceptance';
import { isTestRuntime } from '../utils/runtime';
import {
  discoverUsLeadsFromNotaryCafeIndex,
  prioritizeAiLeadSources,
  type NotaryCafeDiscoveryResult,
} from './notarycafe-search';
import {
  discoverUsLeadsFromPublicDirectories,
  type PublicDirectoryDiscoveryResult,
} from './public-directory-discovery';

export type AiDiscoveryResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  coverage: ProviderCoverage[];
  aiAssistance: 'enabled' | 'disabled' | 'failed' | 'rate_limited';
  researchCandidates: ResearchCandidate[];
  reviewCandidates?: ReviewCandidate[];
  /** Persisted by the durable orchestrator to resume small OSM spatial batches. */
  publicListingProgress?: Pick<
    OsmDiscoveryBatchResult,
    | 'totalBoxCount'
    | 'nextBoxCursor'
    | 'attemptedBoxCount'
    | 'completedBoxCount'
    | 'failedBoxCount'
    | 'timedOut'
    | 'completed'
    | 'stoppedEarly'
  >;
  publicCoverage?: LinkedInDiscoveryResult['coverage'];
  enrichedCount: number;
};

type AiDiscoveryDeps = {
  discoverLinkedin?: typeof discoverUsLeadsFromLinkedinSearch;
  discoverPublicListings?: typeof discoverUsLeadsFromOsm;
  discoverPublicListingsBatch?: typeof discoverUsLeadsFromOsmBatch;
  discoverGmbListings?: typeof discoverUsLeadsFromOsm;
  enrichPublicContacts?: typeof enrichLinkedinLeadsWithPublicContacts;
  /** Legacy test/integration hook retained but deliberately ignored: query planning is deterministic. */
  expandQuery?: unknown;
  discoverGemini?: typeof discoverGeminiResearch;
  discoverNotaryCafe?: typeof discoverUsLeadsFromNotaryCafeIndex;
  discoverPublicDirectories?: typeof discoverUsLeadsFromPublicDirectories;
};

const discoveryWindowMs = 24_000;
const contactEnrichmentWindowMs = 18_000;
const maxGeminiListingSeeds = 40;
const maxAiGmbCandidates = 500;
const maxInitialOsmBoxes = 4;
const getAiDiscoveryWindowMs = (requestedCount: number) =>
  requestedCount >= 100 ? 32_000 : discoveryWindowMs;
const getAiGmbSearchQueryLimit = (
  requestedCount: number,
  locationMode: NormalizedUsLocation['mode'],
) =>
  Math.min(
    16,
    Math.max(
      locationMode === 'timezone' || locationMode === 'nationwide' ? 8 : 3,
      Math.ceil(Math.max(50, requestedCount) / 50) + 2,
    ),
  );
// Keep the orchestration budget at least as large as Gemini's grounded request
// budget so the wrapper does not discard a response that the provider is still
// allowed to finish.
const geminiDiscoveryTimeoutMs = 20_000;
const withTimeout = async <T>(promise: Promise<T>, deadlineMs: number, message: string) => {
  const remainingMs = Math.max(1, deadlineMs - Date.now());
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const isTimeoutFailure = (error: unknown) =>
  error instanceof Error && /deadline|timed out|timeout/i.test(error.message);

const isRateLimitFailure = (error: unknown) =>
  error instanceof Error && /429|rate.?limit|too many requests|quota/i.test(error.message);

const addWarning = (warnings: ProviderWarning[], warning: ProviderWarning) => {
  if (
    warnings.some(
      (existing) =>
        existing.providerId === warning.providerId && existing.message === warning.message,
    )
  ) {
    return;
  }

  warnings.push(warning);
};

const buildCoverage = (
  gmbConfigured = false,
  notaryCafeConfigured = false,
  publicDirectoriesConfigured = false,
): ProviderCoverage[] => {
  const geminiKeyCount = getGeminiApiKeyCount();
  const geminiKeySummary = geminiKeyCount > 1
    ? `${geminiKeyCount} Gemini API keys are pooled and rotated across healthy requests.`
    : 'A Gemini API key is configured for public research.';

  const coverage: ProviderCoverage[] = [
  ...salesProviderAudits.map((provider) => ({
    providerId: `${provider.id}-audit`,
    providerName: provider.name,
    status: 'not_configured' as const,
    leadCount: 0,
    message: provider.limitation,
  })),
  {
    providerId: 'notarycafe-indexed-search',
    providerName: 'NotaryCafe, Indexed Public Search',
    status: notaryCafeConfigured ? 'configured' : 'not_configured',
    leadCount: 0,
    message: notaryCafeConfigured
      ? 'Connected to every AI search as a bounded indexed public cross-check. Only category-relevant NotaryCafe profiles with public phone evidence can be promoted; direct page access, login, CAPTCHA, Cloudflare, and geo-block bypasses are disabled.'
      : 'NotaryCafe indexed search is unavailable for this execution path.',
  },
  {
    providerId: 'linkedin-public-search',
    providerName: 'Public LinkedIn Search',
    status: 'configured' as const,
    leadCount: 0,
    message: 'Free public search engines only; private profiles are not accessed.',
  },
  {
    providerId: 'public-website-enrichment',
    providerName: 'Public Website Enrichment',
    status: 'configured' as const,
    leadCount: 0,
    message: 'A bounded crawl checks public business pages; only their published phone numbers and emails are used.',
  },
  {
    providerId: 'public-business-listings',
    providerName: 'Public Business Listings',
    status: 'configured' as const,
    leadCount: 0,
    message: 'Free OpenStreetMap/Overpass data only; public listing records are merged without paid databases.',
  },
  {
    providerId: 'yelp-public-directory',
    providerName: 'Yelp, Public Directory',
    status: publicDirectoriesConfigured ? 'configured' : 'not_configured',
    leadCount: 0,
    message: publicDirectoriesConfigured
      ? 'Bounded public Yelp result pages are checked for visible business phones; access challenges are reported, not bypassed.'
      : 'Yelp public-directory discovery is unavailable for this execution path.',
  },
  {
    providerId: 'yellow-pages-public-directory',
    providerName: 'Yellow Pages, Public Directory',
    status: publicDirectoriesConfigured ? 'configured' : 'not_configured',
    leadCount: 0,
    message: publicDirectoriesConfigured
      ? 'Bounded public Yellow Pages result pages are checked for visible business phones; access challenges are reported, not bypassed.'
      : 'Yellow Pages public-directory discovery is unavailable for this execution path.',
  },
  {
    providerId: 'google-places-ai',
    providerName: 'Google Business (GMB) listings',
    status: gmbConfigured ? 'configured' : 'not_configured',
    leadCount: 0,
    message: gmbConfigured
      ? 'Configured Google Business (GMB) listing seeds are passed to Gemini for public detail and contact research; Google usage terms and billing still apply.'
      : 'Google Business listing seeds are unavailable; the free public-listing fallback remains available.',
  },
  {
    providerId: 'gemini-query-assistance',
    providerName: 'Deterministic search planning',
    status: 'configured' as const,
    leadCount: 0,
    message: 'Deterministic category, role, and concrete-location lenses are prepared without a separate model request. They are folded into the single grounded Gemini pass when Gemini is available.',
  },
  {
    providerId: 'gemini-public-discovery',
    providerName: 'Gemini public discovery',
    status: isGeminiLeadDiscoveryEnabled() ? 'configured' : 'not_configured',
    leadCount: 0,
    message: isGeminiLeadDiscoveryEnabled()
      ? `${geminiKeySummary} One grounded public-web pass is bounded to the highest-quality listing seeds; only public phone evidence makes a lead exportable.`
      : 'Grounded public discovery is unavailable until Gemini is configured; deterministic public sources continue.',
  },
  {
    providerId: 'gemini-listing-enrichment',
    providerName: 'Gemini listing enrichment',
    status: isGeminiLeadDiscoveryEnabled() ? 'configured' : 'not_configured',
    leadCount: 0,
    message: isGeminiLeadDiscoveryEnabled()
      ? `${geminiKeySummary} At most ${maxGeminiListingSeeds} de-duplicated public listing seeds are folded into the same grounded pass.`
      : 'Gemini listing enrichment is unavailable until Gemini is configured; original public listing fields remain available.',
  },
  {
    providerId: 'linkedin-public-google-business-fusion',
    providerName: 'LinkedIn + Google Business fusion',
    status: 'configured' as const,
    leadCount: 0,
    message: 'Final corroboration stage; only independently evidenced LinkedIn and Google Business signals are fused and retained.',
  },
  ];

  const initializedAt = new Date().toISOString();
  return coverage
    .map((provider, index) => ({
      provider,
      index,
      priority: getPublicProviderPriority(provider),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ provider }) => ({
      ...provider,
      phase: provider.status === 'not_configured' ? 'skipped' as const : 'queued' as const,
      outcome: provider.status === 'not_configured' ? 'not_configured' as const : 'not_started' as const,
      attemptedCount: 0,
      observedCount: 0,
      acceptedCount: 0,
      reviewCount: 0,
      deferredCount: 0,
      updatedAt: initializedAt,
    }));
};

const updateCoverage = (
  coverage: ProviderCoverage[],
  providerId: string,
  patch: Partial<ProviderCoverage>,
) => {
  const entry = coverage.find((item) => item.providerId === providerId);
  if (entry) {
    Object.assign(entry, { ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() });
  }
};

const uniqueSearchQueries = (values: string[]) => {
  const seen = new Set<string>();

  return values
    .map((value) => value.trim().replace(/\s+/g, ' '))
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;

      seen.add(key);
      return true;
    });
};

/**
 * Google Places does not understand a timezone label as a geographic search
 * area. Rotate concrete city/state seeds first so broad AI searches do not
 * spend their entire query budget on "HVAC in Eastern Time".
 */
export const buildAiGmbSearchPlan = (
  companyType: string,
  location: NormalizedUsLocation,
  profile: ReturnType<typeof resolveCategoryProfile>,
) => {
  const baselineQueries = buildDiscoveryQueryVariants(companyType, location, profile);
  const isBroadLocation = location.mode === 'timezone' || location.mode === 'nationwide';

  if (!isBroadLocation) {
    return {
      query: baselineQueries[0] ?? `${companyType} in ${location.label}`,
      queryVariants: baselineQueries.slice(1),
    };
  }

  const locationSeeds = buildDiscoverySeeds(location).slice(
    0,
    location.mode === 'timezone' ? 20 : 32,
  );
  const categoryTerms = uniqueSearchQueries([
    companyType,
    profile.label,
    ...(profile.searchTerms ?? []),
  ]).slice(0, 3);
  const seededQueries: string[] = [];

  // Interleave locations before synonyms. This gives an eight-query request
  // real geographic coverage instead of eight variants for one city.
  for (const categoryTerm of categoryTerms) {
    for (const locationSeed of locationSeeds) {
      seededQueries.push(`${categoryTerm} in ${locationSeed}`);
    }
  }

  for (const categoryTerm of categoryTerms.slice(0, 2)) {
    for (const locationSeed of locationSeeds) {
      seededQueries.push(`${categoryTerm} near ${locationSeed}`);
    }
  }

  const queries = uniqueSearchQueries([...seededQueries, ...baselineQueries]);

  return {
    query: queries[0] ?? `${companyType} in ${location.label}`,
    queryVariants: queries.slice(1),
  };
};

const buildGeminiLocationContext = (location: NormalizedUsLocation) => {
  if (location.mode !== 'timezone' && location.mode !== 'nationwide') {
    return location.label;
  }

  const seeds = buildDiscoverySeeds(location).slice(
    0,
    location.mode === 'timezone' ? 20 : 32,
  );

  return seeds.length
    ? `${location.label}; search representative US locations instead of treating the label as a city: ${seeds.join(', ')}`
    : location.label;
};

const discoverGoogleBusinessListingsForAi: typeof discoverUsLeadsFromOsm = async ({
  request,
  location,
  profile,
  deadlineMs,
}) => {
  if (!isGooglePlacesConfigured()) return [];

  const googleRequest: SearchRequest = {
    companyType: request.companyType,
    sourceMode: 'gmb',
    city: location.label,
    count: request.count,
    phoneRequired: true,
  };
  const searchPlan = buildAiGmbSearchPlan(request.companyType, location, profile);

  return googlePlacesProvider.fetchLeads({
    rawQuery: `${request.companyType} in ${location.label}`,
    query: searchPlan.query,
    queryVariants: searchPlan.queryVariants,
    request: googleRequest,
    location,
    deadlineMs,
    maxLeadCount: Math.min(Math.max(request.count, 20), maxAiGmbCandidates),
    maxSearchQueries: getAiGmbSearchQueryLimit(request.count, location.mode),
    // Two concurrent public query paths improve recall for larger requests
    // without opening an unbounded request fan-out that would trigger throttling.
    maxConcurrentSearches:
      request.count >= 100 || location.mode === 'timezone' || location.mode === 'nationwide'
        ? 2
        : 1,
  });
};

const listingSeedKey = (lead: Lead) =>
  [lead.listingUrl, lead.website, lead.name, lead.address]
    .map((value) => value?.trim().toLowerCase())
    .filter(Boolean)
    .join('|');

const selectListingSeeds = (leads: Lead[]) => {
  const seen = new Set<string>();

  return leads
    .filter((lead) => {
      const key = listingSeedKey(lead);
      if (!key) return true;
      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .slice(0, maxGeminiListingSeeds);
};

const emptyGeminiResearch = (): GeminiResearchDiscovery => ({
  candidates: [],
  groundingSources: [],
  leads: [],
});

const buildDeterministicQueryHints = (
  request: SearchRequest,
  location: NormalizedUsLocation,
) => {
  const profile = resolveCategoryProfile(request.companyType);
  const locationLabel = location.mode === 'local' ? location.label : buildGeminiLocationContext(location);
  return uniqueSearchQueries([
    request.researchBrief?.trim() ?? '',
    `${profile.label} owner ${locationLabel}`,
    `${profile.label} founder ${locationLabel}`,
    ...profile.searchTerms.slice(0, 3).map((term) => `${term} owner ${locationLabel}`),
  ]).slice(0, 8);
};

const createLeadReviewCandidate = (
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

  return {
    id: `${providerId}-review-${lead.id}`,
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

const createGeminiReviewCandidate = (candidate: ResearchCandidate): ReviewCandidate => {
  const hasReportedPhone = Boolean(candidate.reportedPhone?.trim());
  const needsSourceReview = candidate.status === 'needs_source_review';

  return {
    id: `gemini-public-discovery-review-${candidate.id}`,
    providerId: 'gemini-public-discovery',
    providerName: 'Gemini public discovery',
    reason: needsSourceReview || hasReportedPhone
      ? 'missing_source_evidence'
      : 'missing_public_phone',
    reasonDetail: needsSourceReview || hasReportedPhone
      ? 'This grounded public reference still needs independently verifiable public-source and phone-route evidence before it can become an exportable lead.'
      : 'This grounded public reference did not expose a validated public US phone route, so it remains review-only.',
    name: candidate.name,
    personName: candidate.personName,
    organizationName: candidate.organizationName,
    originalRole: candidate.originalRole,
    location: candidate.location,
    website: candidate.website,
    profileUrl: candidate.profileUrl,
    reportedPhone: candidate.reportedPhone,
    reportedEmail: candidate.reportedEmail,
    sourceUrls: candidate.sourceUrls,
    sourceTitles: candidate.sourceTitles,
    evidence: candidate.evidence,
    discoveredAt: candidate.discoveredAt,
  };
};

const dedupeReviewCandidates = (candidates: ReviewCandidate[]) => {
  const unique = new Map<string, ReviewCandidate>();
  for (const candidate of candidates) {
    if (!candidate || !candidate.id || unique.has(candidate.id)) continue;
    unique.set(candidate.id, candidate);
  }
  return [...unique.values()].slice(0, 200);
};

export const createAiLeadDiscovery = (deps: AiDiscoveryDeps = {}) => {
  const discoverLinkedin = deps.discoverLinkedin ?? discoverUsLeadsFromLinkedinSearch;
  const discoverPublicListings = deps.discoverPublicListings;
  const discoverPublicListingsBatch = deps.discoverPublicListingsBatch;
  const discoverGmbListings = deps.discoverGmbListings;
  const discoverPublicDirectories =
    deps.discoverPublicDirectories ??
    (isTestRuntime() ? undefined : discoverUsLeadsFromPublicDirectories);
  const enrichPublicContacts =
    deps.enrichPublicContacts ?? enrichLinkedinLeadsWithPublicContacts;
  const discoverGemini = deps.discoverGemini ?? discoverGeminiResearch;
  const discoverNotaryCafe =
    deps.discoverNotaryCafe ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromNotaryCafeIndex);

  return async ({
    request,
    location,
    deadlineMs = Date.now() + discoveryWindowMs + contactEnrichmentWindowMs,
    deferFinalization = false,
    publicListingBoxCursor = 0,
    publicListingMaxBoxes = maxInitialOsmBoxes,
  }: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    deadlineMs?: number;
    /** Durable Vercel runs split website recovery and final fusion into later ticks. */
    deferFinalization?: boolean;
    /** Durable OSM cursor; omitted for the backwards-compatible full provider call. */
    publicListingBoxCursor?: number;
    /** Maximum OSM boxes to include in this source-discovery tick. */
    publicListingMaxBoxes?: number;
  }): Promise<AiDiscoveryResult> => {
    const warnings: ProviderWarning[] = [
      {
        providerId: 'ai-mode-policy',
        providerName: 'AI mode',
        message: freeAiModePolicy,
      },
    ];
    const coverage = buildCoverage(
      Boolean(discoverGmbListings),
      Boolean(discoverNotaryCafe),
      Boolean(discoverPublicDirectories),
    );
    let aiAssistance: AiDiscoveryResult['aiAssistance'] = isGeminiLeadDiscoveryEnabled()
      ? 'enabled'
      : 'disabled';
    let researchCandidates: ResearchCandidate[] = [];
    let reviewCandidates: ReviewCandidate[] = [];
    let publicListingProgress: AiDiscoveryResult['publicListingProgress'];
    let geminiDiscoveryFailed = false;
    let geminiDiscoveryRateLimited = false;
    const queryHints = buildDeterministicQueryHints(request, location);

    const discoveryDeadlineMs = Math.min(
      deadlineMs,
      Date.now() + getAiDiscoveryWindowMs(request.count),
    );
    const geminiLocationContext = buildGeminiLocationContext(location);
    const geminiRequest: SearchRequest = {
      ...request,
      researchBrief: uniqueSearchQueries([
        request.researchBrief?.trim() ?? '',
        `Deterministic public search lenses: ${queryHints.join(' | ')}`,
      ]).join('\n').slice(0, 1_800),
    };

    updateCoverage(coverage, 'gemini-query-assistance', {
      status: 'returned',
      phase: 'completed',
      outcome: 'returned',
      observedCount: queryHints.length,
      acceptedCount: 0,
      leadCount: 0,
      message: `Prepared ${queryHints.length} deterministic category, role, and location search lens${queryHints.length === 1 ? '' : 'es'} without a separate Gemini request.`,
    });

    const gmbListingPromise = discoverGmbListings
      ? withTimeout(
          discoverGmbListings({
            request: {
              ...request,
              city: location.label,
              count: request.count,
              sourceMode: 'gmb',
              phoneRequired: true,
            } as Parameters<typeof discoverUsLeadsFromOsm>[0]['request'],
            location,
            profile: resolveCategoryProfile(request.companyType),
            deadlineMs: discoveryDeadlineMs,
          }),
          // Allow in-flight public requests to finish after the provider's
          // stop-start deadline so already-collected GMB phones are retained.
          Math.min(deadlineMs, discoveryDeadlineMs + (request.count >= 100 ? 4_000 : 1_000)),
          'Google Business listing discovery timed out; other public sources were preserved.',
        )
          .then((leads) => {
            const acceptedCount = leads.filter(isPhoneQualifiedLead).length;
            updateCoverage(coverage, 'google-places-ai', {
              status: 'returned',
              phase: 'completed',
              outcome: leads.length ? 'returned' : 'empty',
              attemptedCount: 1,
              observedCount: leads.length,
              acceptedCount,
              leadCount: acceptedCount,
              message: `Google Business (GMB) observed ${leads.length} de-duplicated public listing seed${leads.length === 1 ? '' : 's'}; ${acceptedCount} currently pass the public-phone gate. The best ${Math.min(maxGeminiListingSeeds, leads.length)} seed${leads.length === 1 ? '' : 's'} may enter the single grounded Gemini pass.`,
            });
            return leads;
          })
          .catch((error): Lead[] => {
            const timedOut = isTimeoutFailure(error);
            addWarning(warnings, {
              providerId: 'google-places-ai',
              providerName: 'Google Business (GMB) listings',
              message:
                error instanceof Error
                  ? `${error.message} Other public sources were preserved.`
                  : 'Google Business listing discovery failed. Other public sources were preserved.',
              severity: 'warning',
            });
            updateCoverage(coverage, 'google-places-ai', {
              status: timedOut ? 'partial' : 'failed',
              phase: 'degraded',
              outcome: timedOut ? 'timed_out' : 'failed',
              attemptedCount: 1,
              message:
                error instanceof Error
                  ? error.message
                  : 'Google Business listing discovery failed.',
            });
            return [];
          })
      : Promise.resolve([] as Lead[]);

    const publicListingPromise: Promise<{
      leads: Lead[];
      progress?: AiDiscoveryResult['publicListingProgress'];
    }> = discoverPublicListingsBatch
      ? withTimeout(
          discoverPublicListingsBatch({
            request: {
              companyType: request.companyType,
              count: request.count,
            },
            location,
            profile: resolveCategoryProfile(request.companyType),
            deadlineMs: discoveryDeadlineMs,
            boxCursor: publicListingBoxCursor,
            maxBoxes: publicListingMaxBoxes,
          }),
          discoveryDeadlineMs,
          'Public business-listing discovery timed out; other public sources were preserved.',
        )
          .then((batch) => {
            publicListingProgress = {
              totalBoxCount: batch.totalBoxCount,
              nextBoxCursor: batch.nextBoxCursor,
              attemptedBoxCount: batch.attemptedBoxCount,
              completedBoxCount: batch.completedBoxCount,
              failedBoxCount: batch.failedBoxCount,
              timedOut: batch.timedOut,
              completed: batch.completed,
              stoppedEarly: batch.stoppedEarly,
            };
            const leads = batch.leads;
            const acceptedCount = leads.filter(isPhoneQualifiedLead).length;
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
                  : leads.length
                    ? 'returned'
                    : 'empty';
            if (batch.errorMessage) {
              addWarning(warnings, {
                providerId: 'public-business-listings',
                providerName: 'Public Business Listings',
                message: `${batch.errorMessage} Other public listing boxes were preserved for bounded continuation.`,
                severity: batch.timedOut ? 'info' : 'warning',
              });
            }
            updateCoverage(coverage, 'public-business-listings', {
              status: outcome === 'failed' ? 'failed' : outcome === 'timed_out' ? 'partial' : batch.completed ? 'returned' : 'configured',
              phase: outcome === 'failed' || outcome === 'timed_out' ? 'degraded' : batch.completed ? 'completed' : 'queued',
              outcome,
              attemptedCount: batch.attemptedBoxCount,
              observedCount: leads.length,
              acceptedCount,
              deferredCount,
              leadCount: acceptedCount,
              message: batch.completed
                ? `Free public business listings completed ${batch.completedBoxCount}/${batch.totalBoxCount} spatial box${batch.totalBoxCount === 1 ? '' : 'es'}: ${leads.length} de-duplicated candidate${leads.length === 1 ? '' : 's'} observed; ${acceptedCount} currently pass the public-phone gate.`
                : `Free public business listings processed ${batch.completedBoxCount}/${batch.totalBoxCount} spatial boxes; ${deferredCount} box${deferredCount === 1 ? '' : 'es'} are persisted for the next durable tick.`,
            });
            return { leads, progress: publicListingProgress };
          })
          .catch((error) => {
            addWarning(warnings, {
              providerId: 'public-business-listings',
              providerName: 'Public Business Listings',
              message:
                error instanceof Error
                  ? `${error.message} Other public results were preserved.`
                  : 'Public business-listing discovery failed. Other public results were preserved.',
              severity: isTimeoutFailure(error) ? 'info' : 'warning',
            });
            updateCoverage(coverage, 'public-business-listings', {
              status: isTimeoutFailure(error) ? 'partial' : 'failed',
              phase: 'degraded',
              outcome: isTimeoutFailure(error) ? 'timed_out' : 'failed',
              attemptedCount: 1,
              message:
                error instanceof Error ? error.message : 'Public business-listing discovery failed.',
            });
            return { leads: [] };
          })
      : discoverPublicListings
        ? withTimeout(
            discoverPublicListings({
              request: {
                companyType: request.companyType,
                // The OSM provider adds its own phone-gate headroom. Passing the
                // already-expanded target multiplied broad timezone queries into
                // unnecessarily large Overpass requests.
                count: request.count,
              },
              location,
              profile: resolveCategoryProfile(request.companyType),
              deadlineMs: discoveryDeadlineMs,
            }),
            discoveryDeadlineMs,
            'Public business-listing discovery timed out; other public sources were preserved.',
          )
            .then((leads) => {
              const acceptedCount = leads.filter(isPhoneQualifiedLead).length;
              updateCoverage(coverage, 'public-business-listings', {
                status: 'returned',
                phase: 'completed',
                outcome: leads.length ? 'returned' : 'empty',
                attemptedCount: 1,
                observedCount: leads.length,
                acceptedCount,
                leadCount: acceptedCount,
                message: `Free public business listings observed ${leads.length} de-duplicated candidate${leads.length === 1 ? '' : 's'}; ${acceptedCount} currently pass the public-phone gate.`,
              });
              return { leads };
            })
            .catch((error) => {
              addWarning(warnings, {
                providerId: 'public-business-listings',
                providerName: 'Public Business Listings',
                message:
                  error instanceof Error
                    ? `${error.message} Other public results were preserved.`
                    : 'Public business-listing discovery failed. Other public results were preserved.',
                severity: isTimeoutFailure(error) ? 'info' : 'warning',
              });
              updateCoverage(coverage, 'public-business-listings', {
                status: isTimeoutFailure(error) ? 'partial' : 'failed',
                phase: 'degraded',
                outcome: isTimeoutFailure(error) ? 'timed_out' : 'failed',
                attemptedCount: 1,
                message:
                  error instanceof Error ? error.message : 'Public business-listing discovery failed.',
              });
              return { leads: [] };
            })
        : Promise.resolve({ leads: [] });

    const publicDirectoryPromise: Promise<PublicDirectoryDiscoveryResult> = discoverPublicDirectories
      ? withTimeout(
          discoverPublicDirectories({
            request,
            location,
            deadlineMs: discoveryDeadlineMs,
          }),
          discoveryDeadlineMs,
          'Public directory discovery timed out; other public sources were preserved.',
        )
          .then((result: PublicDirectoryDiscoveryResult) => {
            const safeResult: PublicDirectoryDiscoveryResult = {
              leads: Array.isArray(result.leads) ? result.leads : [],
              reviewCandidates: Array.isArray(result.reviewCandidates)
                ? result.reviewCandidates
                : [],
              warnings: Array.isArray(result.warnings) ? result.warnings : [],
              coverage: Array.isArray(result.coverage) ? result.coverage : [],
            };
            for (const warning of safeResult.warnings) addWarning(warnings, warning);
            for (const entry of safeResult.coverage) {
              updateCoverage(coverage, entry.providerId, {
                ...entry,
              });
            }
            return safeResult;
          })
          .catch((error): PublicDirectoryDiscoveryResult => {
            const timedOut = isTimeoutFailure(error);
            const message = error instanceof Error
              ? `${error.message} Other public sources were preserved.`
              : 'Public directory discovery failed. Other public sources were preserved.';
            addWarning(warnings, {
              providerId: 'public-directories',
              providerName: 'Public directories',
              message,
              severity: timedOut ? 'info' : 'warning',
            });
            for (const providerId of ['yelp-public-directory', 'yellow-pages-public-directory']) {
              updateCoverage(coverage, providerId, {
                status: timedOut ? 'partial' : 'failed',
                phase: 'degraded',
                outcome: timedOut ? 'timed_out' : 'failed',
                attemptedCount: 1,
                message,
              });
            }
            return { leads: [], reviewCandidates: [], warnings: [], coverage: [] };
          })
      : Promise.resolve({ leads: [], reviewCandidates: [], warnings: [], coverage: [] });

    const notaryCafePromise: Promise<NotaryCafeDiscoveryResult> = discoverNotaryCafe
      ? withTimeout(
          discoverNotaryCafe({
            request,
            location,
            deadlineMs: discoveryDeadlineMs,
          }),
          discoveryDeadlineMs,
          'Indexed NotaryCafe search timed out; other public sources were preserved.',
        )
          .then((result: NotaryCafeDiscoveryResult) => {
            const safeLeads = Array.isArray(result.leads) ? result.leads : [];
            const safeReviews = Array.isArray(result.reviewCandidates)
              ? result.reviewCandidates
              : [];
            const reportedCoverage = result.coverage ?? {} as Partial<NotaryCafeDiscoveryResult['coverage']>;
            const safeCoverage = {
              queriesAttempted: reportedCoverage.queriesAttempted ?? 0,
              providersChecked: reportedCoverage.providersChecked ?? 0,
              observedCandidates:
                reportedCoverage.observedCandidates ?? safeLeads.length + safeReviews.length,
              acceptedCandidates: reportedCoverage.acceptedCandidates ?? safeLeads.length,
              reviewCandidates: reportedCoverage.reviewCandidates ?? safeReviews.length,
              deferredQueries: reportedCoverage.deferredQueries ?? 0,
              blockedProviders: reportedCoverage.blockedProviders ?? 0,
            };
            for (const warning of (Array.isArray(result.warnings) ? result.warnings : [])) {
              addWarning(warnings, warning);
            }
            const outcome: NonNullable<ProviderCoverage['outcome']> = safeCoverage.deferredQueries
              ? 'deferred'
              : safeCoverage.blockedProviders
                ? 'blocked'
                : safeCoverage.acceptedCandidates
                  ? 'returned'
                  : safeCoverage.reviewCandidates
                    ? 'filtered'
                    : safeCoverage.queriesAttempted
                      ? 'empty'
                      : 'not_started';
            updateCoverage(coverage, 'notarycafe-indexed-search', {
              status: outcome === 'blocked' ? 'partial' : outcome === 'deferred' ? 'configured' : 'returned',
              phase: outcome === 'blocked' ? 'degraded' : outcome === 'deferred' || outcome === 'not_started' ? 'queued' : 'completed',
              outcome,
              attemptedCount: safeCoverage.queriesAttempted,
              observedCount: safeCoverage.observedCandidates,
              acceptedCount: safeCoverage.acceptedCandidates,
              reviewCount: safeCoverage.reviewCandidates,
              deferredCount: safeCoverage.deferredQueries,
              leadCount: safeCoverage.acceptedCandidates,
              message: safeLeads.length
                ? `Priority indexed NotaryCafe evidence matched ${safeLeads.length} of ${safeCoverage.observedCandidates} screened public profile${safeCoverage.observedCandidates === 1 ? '' : 's'}; direct page access was not attempted.`
                : `Indexed NotaryCafe completed: 0 matched / ${safeCoverage.observedCandidates} screened for ${request.companyType}${safeCoverage.reviewCandidates ? `; ${safeCoverage.reviewCandidates} candidate${safeCoverage.reviewCandidates === 1 ? '' : 's'} retained for review` : ''}.`,
            });
            return {
              ...result,
              leads: safeLeads,
              reviewCandidates: safeReviews,
              warnings: Array.isArray(result.warnings) ? result.warnings : [],
              coverage: safeCoverage,
            };
          })
          .catch((error): NotaryCafeDiscoveryResult => {
            const timedOut = isTimeoutFailure(error);
            const message = error instanceof Error
              ? `${error.message} Other public sources were preserved.`
              : 'Indexed NotaryCafe search failed. Other public sources were preserved.';
            addWarning(warnings, {
              providerId: 'notarycafe-indexed-search',
              providerName: 'NotaryCafe, Indexed Public Search',
              message,
              severity: timedOut ? 'info' : 'warning',
            });
            updateCoverage(coverage, 'notarycafe-indexed-search', {
              status: timedOut ? 'partial' : 'failed',
              phase: 'degraded',
              outcome: timedOut ? 'timed_out' : 'failed',
              attemptedCount: 1,
              message,
            });
            return {
              leads: [],
              reviewCandidates: [],
              warnings: [],
              coverage: {
                queriesAttempted: 0,
                providersChecked: 0,
                observedCandidates: 0,
                acceptedCandidates: 0,
                reviewCandidates: 0,
                deferredQueries: 0,
                blockedProviders: 0,
              },
            };
          })
      : Promise.resolve({
          leads: [],
          reviewCandidates: [],
          warnings: [],
          coverage: {
            queriesAttempted: 0,
            providersChecked: 0,
            observedCandidates: 0,
            acceptedCandidates: 0,
            reviewCandidates: 0,
            deferredQueries: 0,
            blockedProviders: 0,
          },
        });

    // A search used to make one grounded Gemini request immediately and then a
    // second grounded request for listing enrichment. That doubled free-tier
    // pressure. Wait for the best public listing seeds and fold them into one
    // grounded pass instead; deterministic sources still run independently.
    const geminiDiscoveryPromise: Promise<GeminiResearchDiscovery> = isGeminiLeadDiscoveryEnabled()
      ? (async () => {
          const listingLeads = (await Promise.all([
            discoverGmbListings ? gmbListingPromise : Promise.resolve([] as Lead[]),
            publicListingPromise.then((result) => result.leads),
            publicDirectoryPromise.then((result) => result.leads),
          ])).flat();
          const listingSeeds = selectListingSeeds(listingLeads);

          if (listingSeeds.length) {
            updateCoverage(coverage, 'gemini-listing-enrichment', {
              status: 'configured',
              phase: 'running',
              outcome: 'not_started',
              observedCount: listingSeeds.length,
              message: `Public listing seeds are included in the single Gemini research pass (${listingSeeds.length} selected).`,
            });
          }

          if (isGeminiRateLimited()) {
            const poolHealth = getGeminiPoolHealth();
            geminiDiscoveryFailed = true;
            geminiDiscoveryRateLimited = true;
            updateCoverage(coverage, 'gemini-public-discovery', {
              status: 'partial',
              phase: 'degraded',
              outcome: 'rate_limited',
              attemptedCount: 1,
              message: `Gemini is cooling down after a free-tier rate-limit response (${poolHealth.coolingDownKeyCount}/${poolHealth.configuredKeyCount} configured key${poolHealth.configuredKeyCount === 1 ? '' : 's'} cooling down); deterministic public discovery continued.`,
            });
            if (listingSeeds.length) {
              updateCoverage(coverage, 'gemini-listing-enrichment', {
                status: 'partial',
                phase: 'degraded',
                outcome: 'rate_limited',
                deferredCount: listingSeeds.length,
                message: 'Gemini listing enrichment was skipped during the free-tier cooldown; original public listing fields remain available.',
              });
            }
            return emptyGeminiResearch();
          }

          try {
            const remainingGeminiMs = discoveryDeadlineMs - Date.now();
            if (remainingGeminiMs <= 1_000) {
              geminiDiscoveryFailed = true;
              const message = 'Gemini public discovery was skipped because the bounded discovery window was nearly exhausted; deterministic public sources were preserved.';
              addWarning(warnings, {
                providerId: 'gemini-public-discovery',
                providerName: 'Gemini public discovery',
                message,
                severity: 'info',
              });
              updateCoverage(coverage, 'gemini-public-discovery', {
                status: 'partial',
                phase: 'queued',
                outcome: 'deferred',
                deferredCount: 1,
                message,
              });
              return emptyGeminiResearch();
            }

            const requestTimeoutMs = Math.min(geminiDiscoveryTimeoutMs, remainingGeminiMs);
            const grounded = await withTimeout(
              discoverGemini(
                geminiRequest,
                location.label,
                listingSeeds,
                geminiLocationContext,
                requestTimeoutMs,
              ),
              Math.min(discoveryDeadlineMs, Date.now() + requestTimeoutMs),
              'Gemini public discovery timed out; deterministic public sources were preserved.',
            );
            updateCoverage(coverage, 'gemini-listing-enrichment', {
              status: 'returned',
              phase: 'completed',
              outcome: listingSeeds.length ? 'returned' : 'empty',
              attemptedCount: listingSeeds.length ? 1 : 0,
              observedCount: listingSeeds.length,
              acceptedCount: 0,
              reviewCount: grounded.candidates.length,
              leadCount: 0,
              message: listingSeeds.length
                ? `Single Gemini public-research pass included ${listingSeeds.length} public listing seed${listingSeeds.length === 1 ? '' : 's'}; original listing fields remain preserved.`
                : 'No public listing seeds were available for the single Gemini research pass.',
            });
            return grounded;
          } catch (error) {
            const timedOut = isTimeoutFailure(error);
            const rateLimited = isRateLimitFailure(error);
            geminiDiscoveryFailed = true;
            geminiDiscoveryRateLimited ||= rateLimited;
            const message = rateLimited
              ? 'Gemini free-tier quota or rate limit was reached; deterministic public discovery continued and no unverified Gemini details were promoted.'
              : error instanceof Error
                ? `${error.message} Deterministic public discovery continued.`
                : 'Gemini public discovery failed. Deterministic public discovery continued.';
            addWarning(warnings, {
              providerId: 'gemini-public-discovery',
              providerName: 'Gemini public discovery',
              message,
              severity: timedOut || rateLimited ? 'info' : 'warning',
            });
            updateCoverage(coverage, 'gemini-public-discovery', {
              status: timedOut || rateLimited ? 'partial' : 'failed',
              phase: 'degraded',
              outcome: rateLimited ? 'rate_limited' : timedOut ? 'timed_out' : 'failed',
              attemptedCount: 1,
              message,
            });
            if (listingSeeds.length) {
              updateCoverage(coverage, 'gemini-listing-enrichment', {
                status: timedOut || rateLimited ? 'partial' : 'failed',
                phase: 'degraded',
                outcome: rateLimited ? 'rate_limited' : timedOut ? 'timed_out' : 'failed',
                attemptedCount: 1,
                observedCount: listingSeeds.length,
                deferredCount: listingSeeds.length,
                message: rateLimited
                  ? 'Gemini listing enrichment was skipped after the free-tier limit; original public listing fields and phones remain available.'
                  : 'The single Gemini pass could not enrich the public listing seeds; original listing fields remain available.',
              });
            }
            return emptyGeminiResearch();
          }
        })()
      : Promise.resolve(emptyGeminiResearch());

    const runLinkedinDiscovery = async (
      hints: string[],
      linkedinRequest: SearchRequest = request,
    ): Promise<{ result: LinkedInDiscoveryResult; timedOut: boolean }> => {
      try {
        const result = await withTimeout(
          discoverLinkedin({
            request: linkedinRequest,
            location,
            queryHints: hints,
            deadlineMs: discoveryDeadlineMs,
          }),
          discoveryDeadlineMs,
          'Free public discovery timed out before the batch completed.',
        );
        for (const warning of result.warnings) {
          addWarning(warnings, warning);
        }
        const acceptedCount = result.leads.filter(isPhoneQualifiedLead).length;
        const observedCount = result.leads.length;
        const outcome: NonNullable<ProviderCoverage['outcome']> = result.blocked
          ? 'blocked'
          : observedCount
            ? 'returned'
            : 'empty';
        updateCoverage(coverage, 'linkedin-public-search', {
          status: result.blocked ? 'partial' : 'returned',
          phase: result.blocked ? 'degraded' : 'completed',
          outcome,
          attemptedCount: result.coverage?.queriesAttempted ?? 1,
          observedCount,
          acceptedCount,
          leadCount: acceptedCount,
          message: result.blocked
            ? 'Public search providers were blocked or rate-limited; no unverified profiles were added.'
            : `Public LinkedIn profile results were matched and deduplicated: ${observedCount} observed, ${acceptedCount} currently phone-qualified.`,
        });
        return { result, timedOut: false };
      } catch (error) {
        addWarning(warnings, {
          providerId: 'linkedin-public-search',
          providerName: 'Public LinkedIn Search',
          message:
            error instanceof Error
              ? `${error.message} No unverified leads were added.`
              : 'Free public discovery failed. No unverified leads were added.',
          severity: isTimeoutFailure(error) ? 'info' : 'warning',
        });
        updateCoverage(coverage, 'linkedin-public-search', {
          status: isTimeoutFailure(error) ? 'partial' : 'failed',
          phase: 'degraded',
          outcome: isTimeoutFailure(error) ? 'timed_out' : 'failed',
          attemptedCount: 1,
          message: error instanceof Error ? error.message : 'Public discovery failed.',
        });
        return {
          result: { leads: [], warnings: [], blocked: false },
          timedOut: isTimeoutFailure(error),
        };
      }
    };

    // LinkedIn is always queried with deterministic category, role, and
    // location lenses. There is deliberately no second Gemini planning call
    // and no model-assisted retry: the single grounded Gemini pass below is
    // the only model request in this workflow.
    const linkedinDiscovery = await runLinkedinDiscovery(queryHints);
    const discoveryResult = linkedinDiscovery.result;

    const [publicListingResult, gmbListingLeads, publicDirectoryResult, geminiResult, notaryCafeResult] = await Promise.all([
      publicListingPromise,
      gmbListingPromise,
      publicDirectoryPromise,
      geminiDiscoveryPromise,
      notaryCafePromise,
    ]);
    const publicListingLeads = publicListingResult.leads;
    publicListingProgress = publicListingResult.progress ?? publicListingProgress;
    // Older integrations and test doubles predate the review queue. Treat the
    // additive fields as empty rather than allowing an older provider shape to
    // abort the complete public-source run.
    const publicDirectoryLeads = publicDirectoryResult.leads ?? [];
    const publicDirectoryReviews = publicDirectoryResult.reviewCandidates ?? [];
    const notaryCafeLeads = notaryCafeResult.leads ?? [];
    const notaryCafeReviews = notaryCafeResult.reviewCandidates ?? [];
    if (geminiDiscoveryRateLimited) {
      aiAssistance = 'rate_limited';
    }

    const normalizeProviderLeads = (leads: Lead[]) => leads.flatMap((lead) => {
      try {
        return [enrichLead(lead)];
      } catch {
        return [];
      }
    });
    const normalizedLinkedinLeads = normalizeProviderLeads(discoveryResult.leads);
    const normalizedGeminiLeads = normalizeProviderLeads(geminiResult.leads);
    const normalizedGmbListingLeads = normalizeProviderLeads(gmbListingLeads);
    const normalizedPublicListingLeads = normalizeProviderLeads(publicListingLeads);
    const normalizedPublicDirectoryLeads = normalizeProviderLeads(publicDirectoryLeads);
    const normalizedNotaryCafeLeads = normalizeProviderLeads(notaryCafeLeads);
    const filterLocationSafely = (leads: Lead[]) => leads.filter((lead) => {
      try {
        return filterLeadsForLocation([lead], location).length > 0;
      } catch {
        // A malformed persisted/provider record must never widen the search
        // geography or break the rest of the provider fusion run.
        return false;
      }
    });
    const scopedLinkedinLeads = filterLocationSafely(normalizedLinkedinLeads);
    const scopedGeminiLeads = filterLocationSafely(normalizedGeminiLeads);
    const scopedGmbListingLeads = filterLocationSafely(normalizedGmbListingLeads);
    const scopedPublicListingLeads = filterLocationSafely(normalizedPublicListingLeads);
    const scopedPublicDirectoryLeads = filterLocationSafely(normalizedPublicDirectoryLeads);
    const scopedNotaryCafeLeads = filterLocationSafely(normalizedNotaryCafeLeads);
    const excludedForLocation =
      normalizedLinkedinLeads.length - scopedLinkedinLeads.length +
      normalizedGeminiLeads.length - scopedGeminiLeads.length +
      normalizedGmbListingLeads.length - scopedGmbListingLeads.length +
      normalizedPublicListingLeads.length - scopedPublicListingLeads.length +
      normalizedPublicDirectoryLeads.length - scopedPublicDirectoryLeads.length +
      normalizedNotaryCafeLeads.length - scopedNotaryCafeLeads.length;

    if (excludedForLocation > 0) {
      addWarning(warnings, {
        providerId: 'location-acceptance',
        providerName: 'Deterministic location acceptance',
        message: `Excluded ${excludedForLocation} provider result${excludedForLocation === 1 ? '' : 's'} without a deterministic match for ${location.label}; no out-of-area record was promoted.`,
        severity: 'info',
      });
    }
    updateCoverage(coverage, 'linkedin-public-search', {
      phase: discoveryResult.blocked ? 'degraded' : 'completed',
      outcome: discoveryResult.blocked
        ? 'blocked'
        : scopedLinkedinLeads.length
          ? 'returned'
          : 'empty',
      observedCount: scopedLinkedinLeads.length,
      acceptedCount: scopedLinkedinLeads.filter(isPhoneQualifiedLead).length,
      leadCount: scopedLinkedinLeads.filter(isPhoneQualifiedLead).length,
      message: `Deterministic public LinkedIn discovery used category, role, and location lenses; ${scopedLinkedinLeads.length} result${scopedLinkedinLeads.length === 1 ? '' : 's'} were location-checked.${scopedLinkedinLeads.length < discoveryResult.leads.length ? ' Out-of-area results were excluded.' : ''}`,
    });
    updateCoverage(coverage, 'google-places-ai', {
      observedCount: scopedGmbListingLeads.length,
      acceptedCount: scopedGmbListingLeads.filter(isPhoneQualifiedLead).length,
      leadCount: scopedGmbListingLeads.filter(isPhoneQualifiedLead).length,
    });
    updateCoverage(coverage, 'public-business-listings', {
      observedCount: scopedPublicListingLeads.length,
      acceptedCount: scopedPublicListingLeads.filter(isPhoneQualifiedLead).length,
      leadCount: scopedPublicListingLeads.filter(isPhoneQualifiedLead).length,
    });
    for (const [providerId, source] of [
      ['yelp-public-directory', 'Yelp'],
      ['yellow-pages-public-directory', 'Yellow Pages'],
    ] as const) {
      const directoryCoverage = coverage.find((entry) => entry.providerId === providerId);
      if (!directoryCoverage) continue;

      updateCoverage(coverage, providerId, {
        acceptedCount: scopedPublicDirectoryLeads.filter((lead) =>
          lead.source.trim().toLowerCase().includes(source.toLowerCase()),
        ).filter(isPhoneQualifiedLead).length,
        leadCount: scopedPublicDirectoryLeads.filter((lead) =>
          lead.source.trim().toLowerCase().includes(source.toLowerCase()),
        ).filter(isPhoneQualifiedLead).length,
        message: directoryCoverage.message
          ? `${directoryCoverage.message} Location-checked results were merged.`
          : 'Public directory discovery completed; location-checked results were merged.',
      });
    }
    updateCoverage(coverage, 'notarycafe-indexed-search', {
      acceptedCount: scopedNotaryCafeLeads.filter(isPhoneQualifiedLead).length,
      leadCount: scopedNotaryCafeLeads.filter(isPhoneQualifiedLead).length,
    });

    researchCandidates = geminiResult.candidates;
    const geminiReviewCandidates = researchCandidates.map(createGeminiReviewCandidate);
    const geminiAcceptedCount = scopedGeminiLeads.filter(isPhoneQualifiedLead).length;
    updateCoverage(coverage, 'gemini-public-discovery', {
      status: !isGeminiLeadDiscoveryEnabled()
        ? 'not_configured'
        : geminiDiscoveryFailed
          ? 'partial'
          : 'returned',
      phase: !isGeminiLeadDiscoveryEnabled()
        ? 'skipped'
        : geminiDiscoveryFailed
          ? 'degraded'
          : 'completed',
      outcome: !isGeminiLeadDiscoveryEnabled()
        ? 'not_configured'
        : geminiDiscoveryRateLimited
          ? 'rate_limited'
          : geminiDiscoveryFailed
            ? 'failed'
            : researchCandidates.length
              ? 'filtered'
              : 'empty',
      attemptedCount: isGeminiLeadDiscoveryEnabled() ? 1 : 0,
      observedCount: researchCandidates.length,
      acceptedCount: geminiAcceptedCount,
      reviewCount: geminiReviewCandidates.length,
      leadCount: geminiAcceptedCount,
      message: !isGeminiLeadDiscoveryEnabled()
        ? 'Grounded Gemini public discovery was not configured.'
        : geminiDiscoveryRateLimited
          ? 'Gemini free-tier quota or rate limit was reached; deterministic public sources and original listing fields were preserved.'
        : geminiDiscoveryFailed
          ? 'Gemini public discovery was not fully available; public candidates from other sources were preserved.'
          : `Retained ${researchCandidates.length} Gemini public research candidate${researchCandidates.length === 1 ? '' : 's'}; candidates remain visible even when phone validation excludes them from export.`,
    });

    const fusion = deferFinalization
      ? undefined
      : mergeLinkedInWithPublicListingsWithDiagnostics(
          [...scopedLinkedinLeads, ...scopedGeminiLeads],
          scopedGmbListingLeads,
        );
    reviewCandidates = dedupeReviewCandidates([
      ...notaryCafeReviews,
      ...publicDirectoryReviews,
      ...geminiReviewCandidates,
      ...(fusion?.reviewCandidates ?? []),
    ]);
    let leads = deduplicateLeads(
      (fusion
        ? [
            ...fusion.leads,
            ...scopedNotaryCafeLeads,
            ...scopedPublicListingLeads,
            ...scopedPublicDirectoryLeads,
          ]
        : [
            ...scopedLinkedinLeads,
            ...scopedGeminiLeads,
            ...scopedNotaryCafeLeads,
            ...scopedGmbListingLeads,
            ...scopedPublicListingLeads,
            ...scopedPublicDirectoryLeads,
          ]).map(enrichLead),
    );
    leads = prioritizeAiLeadSources(leads);
    let enrichedCount = 0;
    const websiteCandidates = leads.filter((lead) =>
      Boolean(lead.website?.trim()) && (!isPhoneQualifiedLead(lead) || !lead.decisionMakerName),
    );

    if (!deferFinalization && leads.length && Date.now() < deadlineMs) {
      try {
        const contactResult = await withTimeout(
          enrichPublicContacts({
            leads,
            request,
            location,
            deadlineMs: Math.min(deadlineMs, Date.now() + contactEnrichmentWindowMs),
          }),
          deadlineMs,
          'Public website enrichment timed out; discovered profiles were preserved.',
        );
        leads = prioritizeAiLeadSources(
          deduplicateLeads(contactResult.leads.map(enrichLead)),
        );
        enrichedCount = contactResult.enrichedCount;
        for (const warning of contactResult.warnings) {
          addWarning(warnings, warning);
        }
        updateCoverage(coverage, 'public-website-enrichment', {
          status: 'returned',
          phase: 'completed',
          outcome: websiteCandidates.length ? 'returned' : 'empty',
          attemptedCount: websiteCandidates.length,
          observedCount: websiteCandidates.length,
          acceptedCount: enrichedCount,
          leadCount: enrichedCount,
          message: `Public website enrichment completed for ${websiteCandidates.length} unique public business candidate${websiteCandidates.length === 1 ? '' : 's'}; ${enrichedCount} record${enrichedCount === 1 ? '' : 's'} gained openly listed contact or decision-maker evidence.`,
        });
      } catch (error) {
        const timedOut = isTimeoutFailure(error);
        addWarning(warnings, {
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          message:
            error instanceof Error
              ? `${error.message} Public profiles were preserved; contact fields may be incomplete.`
              : 'Public website enrichment failed. Public profiles were preserved; contact fields may be incomplete.',
          severity: timedOut ? 'info' : 'warning',
        });
        if (timedOut) {
          reviewCandidates = dedupeReviewCandidates([
            ...reviewCandidates,
            ...websiteCandidates.map((lead) => createLeadReviewCandidate(
              lead,
              'public-website-enrichment',
              'Public Website Enrichment',
              'website_timeout',
              'The public website did not finish in the bounded enrichment window; the original profile was preserved.',
            )),
          ]);
        }
        updateCoverage(coverage, 'public-website-enrichment', {
          status: timedOut ? 'partial' : 'failed',
          phase: 'degraded',
          outcome: timedOut ? 'timed_out' : 'failed',
          attemptedCount: websiteCandidates.length,
          observedCount: websiteCandidates.length,
          reviewCount: timedOut ? websiteCandidates.length : 0,
          message: error instanceof Error ? error.message : 'Public website enrichment failed.',
        });
      }
    } else if (!leads.length) {
      updateCoverage(coverage, 'public-website-enrichment', {
        status: 'returned',
        phase: 'completed',
        outcome: 'empty',
        message: 'No public website candidates were available for bounded enrichment.',
      });
    } else {
      updateCoverage(coverage, 'public-website-enrichment', {
        status: 'configured',
        phase: 'queued',
        outcome: 'deferred',
        deferredCount: websiteCandidates.length,
        message: 'Public website enrichment was deferred to a later durable tick; discovered profiles were preserved.',
      });
    }

    const addLocationRejectedReviews = (
      sourceLeads: Lead[],
      scopedLeads: Lead[],
      providerId: string,
      providerName: string,
    ) => {
      const scopedIds = new Set(scopedLeads.map((lead) => lead.id));
      return sourceLeads
        .filter((lead) => !scopedIds.has(lead.id))
        .map((lead) => createLeadReviewCandidate(
          lead,
          providerId,
          providerName,
          'location_mismatch',
          `The public record did not deterministically match ${location.label}, so it was not promoted.`,
        ));
    };
    const addPhoneRejectedReviews = (
      sourceLeads: Lead[],
      providerId: string,
      providerName: string,
    ) => sourceLeads
      .filter((lead) => !isPhoneQualifiedLead(lead))
      .map((lead) => createLeadReviewCandidate(
        lead,
        providerId,
        providerName,
        lead.mobile && !normalizeContactPhone(lead.mobile)
          ? 'invalid_public_phone'
          : 'missing_public_phone',
        lead.mobile
          ? 'The public record did not provide a valid US phone with independent public source evidence.'
          : 'The public record did not provide a validated public US phone route.',
      ));

    reviewCandidates = dedupeReviewCandidates([
      ...reviewCandidates,
      ...addLocationRejectedReviews(
        normalizedLinkedinLeads,
        scopedLinkedinLeads,
        'linkedin-public-search',
        'Public LinkedIn Search',
      ),
      ...addLocationRejectedReviews(
        normalizedGmbListingLeads,
        scopedGmbListingLeads,
        'google-places-ai',
        'Google Business (GMB) listings',
      ),
      ...addLocationRejectedReviews(
        normalizedPublicListingLeads,
        scopedPublicListingLeads,
        'public-business-listings',
        'Public Business Listings',
      ),
      ...addPhoneRejectedReviews(scopedLinkedinLeads, 'linkedin-public-search', 'Public LinkedIn Search'),
      ...addPhoneRejectedReviews(scopedGmbListingLeads, 'google-places-ai', 'Google Business (GMB) listings'),
      ...addPhoneRejectedReviews(scopedPublicListingLeads, 'public-business-listings', 'Public Business Listings'),
    ]);

    const reviewCountFor = (providerId: string) =>
      reviewCandidates.filter((candidate) => candidate.providerId === providerId).length;
    updateCoverage(coverage, 'linkedin-public-search', {
      reviewCount: reviewCountFor('linkedin-public-search'),
    });
    updateCoverage(coverage, 'google-places-ai', {
      reviewCount: reviewCountFor('google-places-ai'),
    });
    updateCoverage(coverage, 'public-business-listings', {
      reviewCount: reviewCountFor('public-business-listings'),
    });
    updateCoverage(coverage, 'gemini-public-discovery', {
      reviewCount: reviewCountFor('gemini-public-discovery'),
    });
    updateCoverage(coverage, 'yelp-public-directory', {
      reviewCount: reviewCountFor('yelp-public-directory'),
    });
    updateCoverage(coverage, 'yellow-pages-public-directory', {
      reviewCount: reviewCountFor('yellow-pages-public-directory'),
    });

    if (!discoveryResult.leads.length && discoveryResult.blocked) {
      addWarning(warnings, {
        providerId: 'linkedin-public-search',
        providerName: 'Public LinkedIn Search',
        message:
          'Free public search providers were blocked or rate-limited. No unverified or fabricated leads were added.',
      });
    }

    if (fusion) {
      const fusionLeadCount = fusion.fusedLeadIds.length;
      updateCoverage(coverage, 'linkedin-public-google-business-fusion', {
        status: 'returned',
        phase: 'completed',
        outcome: fusionLeadCount
          ? 'returned'
          : fusion.reviewCandidates.length
            ? 'filtered'
            : 'empty',
        attemptedCount: scopedLinkedinLeads.length,
        observedCount: scopedLinkedinLeads.length,
        acceptedCount: fusionLeadCount,
        reviewCount: fusion.reviewCandidates.length,
        leadCount: fusionLeadCount,
        message: fusionLeadCount
          ? `Final LinkedIn + Google Business fusion retained ${fusionLeadCount} corroborated lead${fusionLeadCount === 1 ? '' : 's'}.`
          : fusion.reviewCandidates.length
            ? `No corroborated fusion lead was retained; ${fusion.reviewCandidates.length} strict near-match${fusion.reviewCandidates.length === 1 ? '' : 'es'} remain in the review queue.`
            : 'Final LinkedIn + Google Business fusion completed with no corroborated match.',
      });
    } else {
      updateCoverage(coverage, 'linkedin-public-google-business-fusion', {
        status: 'configured',
        phase: 'queued',
        outcome: 'deferred',
        deferredCount: scopedLinkedinLeads.length,
        message: 'Final LinkedIn + Google Business fusion is queued after durable website enrichment.',
      });
    }

    return {
      leads: prioritizeAiLeadSources(
        leads,
      ).slice(0, getLeadDiscoveryCandidateTarget(request.count, 3)),
      warnings,
      coverage,
      aiAssistance,
      researchCandidates,
      reviewCandidates,
      publicListingProgress,
      publicCoverage: discoveryResult.coverage,
      enrichedCount,
    };
  };
};

export const discoverUsLeadsFromAiMode = createAiLeadDiscovery(
  isTestRuntime()
    ? {}
    : {
        discoverPublicListings: discoverUsLeadsFromOsm,
        discoverPublicListingsBatch: discoverUsLeadsFromOsmBatch,
        discoverNotaryCafe: discoverUsLeadsFromNotaryCafeIndex,
        discoverPublicDirectories: discoverUsLeadsFromPublicDirectories,
        ...(isGooglePlacesConfigured()
          ? { discoverGmbListings: discoverGoogleBusinessListingsForAi }
          : {}),
      },
);

const buildResponse = ({
  searchId,
  startedAt,
  request,
  locationLabel,
  result,
}: {
  searchId: string;
  startedAt: string;
  request: SearchRequest;
  locationLabel: string;
  result: AiDiscoveryResult;
}): SearchResponse => {
  const deduplicatedLeads = deduplicateLeads(result.leads);
  const phoneRequirement = enforcePhoneRequirement(deduplicatedLeads, request);
  const responseWarnings = [...result.warnings];
  if (phoneRequirement.warning) {
    addWarning(responseWarnings, phoneRequirement.warning);
  }
  const visibleLeads = prioritizeAiLeadSources(phoneRequirement.leads).slice(0, request.count);
  const status = visibleLeads.length ? 'complete' : 'failed';
  if (!visibleLeads.length) {
    addWarning(responseWarnings, noUsableResultsWarning());
  }

  const contract = buildSearchResponseContract(normalizeLeadSourceMode(request.sourceMode ?? 'ai'));
  const completedAt = new Date().toISOString();

  return {
    ...contract,
    searchId,
    leads: visibleLeads,
    researchCandidates: result.researchCandidates,
    ...(result.reviewCandidates?.length ? { reviewCandidates: result.reviewCandidates } : {}),
    meta: {
      ...contract.meta,
      query: `${request.companyType} in ${locationLabel}`,
      locationLabel,
      researchDepth: request.researchDepth ?? 'verified',
      researchBrief: request.researchBrief,
      status,
      execution: buildSearchExecutionContract({
        path: 'stateless',
        startedAt,
        lastProgressAt: completedAt,
        completedAt,
      }),
      qualitySummary: buildLeadQualitySummary(visibleLeads),
      progress: {
        discovered: deduplicatedLeads.length,
        enriched: result.enrichedCount,
        publicContactsFound: visibleLeads.filter((lead) => lead.hasEmail || lead.hasPhone).length,
        phoneExcludedCount: phoneRequirement.excludedCount,
        publicQueriesAttempted: result.publicCoverage?.queriesAttempted,
        publicProvidersChecked: result.publicCoverage?.providersChecked,
        publicQueryFamilies: result.publicCoverage?.queryFamilies,
        publicQueryFamilyCounts: result.publicCoverage?.queryFamilyCounts,
        providerCoverage: result.coverage,
        aiAssistance: result.aiAssistance,
        totalCandidates: deduplicatedLeads.length,
        requestedCount: request.count,
        foundCount: visibleLeads.length,
        duplicatesRemoved: Math.max(0, result.leads.length - deduplicatedLeads.length),
        currentSource: status === 'complete' ? 'Complete' : 'Failed',
        batchesCompleted: 1,
        estimatedRemaining: Math.max(0, request.count - visibleLeads.length),
      },
      totals: {
        total: visibleLeads.length,
        withEmail: visibleLeads.filter((lead) => lead.hasEmail).length,
        withPhone: visibleLeads.filter((lead) => lead.hasPhone).length,
        withWebsite: visibleLeads.filter((lead) => lead.hasWebsite).length,
      },
      providerWarnings: responseWarnings,
    },
  };
};

export const runStatelessAiSearch = async (request: SearchRequest): Promise<SearchResponse> => {
  const startedAt = new Date().toISOString();
  const searchId = `ai-stateless-${randomUUID()}`;
  let location: NormalizedUsLocation;

  try {
    location = await normalizeUsLocation(request.city);
  } catch (error) {
    return buildResponse({
      searchId,
      startedAt,
      request,
      locationLabel: request.city,
      result: {
        leads: [],
        warnings: [
          {
            providerId: 'location-normalizer',
            providerName: 'Location Normalizer',
            message:
              error instanceof Error ? error.message : 'US location normalization failed.',
          },
        ],
        coverage: buildCoverage(),
        aiAssistance: 'disabled',
        researchCandidates: [],
        reviewCandidates: [],
        enrichedCount: 0,
      },
    });
  }

  const result = await discoverUsLeadsFromAiMode({
    request,
    location,
    deadlineMs: Date.now() + discoveryWindowMs + contactEnrichmentWindowMs,
  });

  return buildResponse({
    searchId,
    startedAt,
    request,
    locationLabel: location.label,
    result: {
      ...result,
      warnings: [...location.warnings, ...result.warnings],
    },
  });
};
