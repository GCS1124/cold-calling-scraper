import { randomUUID } from 'node:crypto';

import type { Lead, ResearchCandidate } from '../types/lead';
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
import { discoverUsLeadsFromOsm } from './osm-discovery';
import { normalizeUsLocation } from './us-location';
import { resolveCategoryProfile } from './us-category-mapping';
import { freeAiModePolicy, salesProviderAudits } from '../providers/sales-intelligence';
import { googlePlacesProvider, isGooglePlacesConfigured } from '../providers/google-places';
import {
  expandQueryWithGemini,
  getGeminiApiKeyCount,
  isGeminiRateLimited,
  isGeminiQueryAssistanceEnabled,
  isGeminiLeadDiscoveryEnabled,
} from '../providers/gemini';
import {
  discoverGeminiResearch,
  type GeminiResearchDiscovery,
} from './gemini-lead-discovery';
import { runGeminiQueryAssistance } from './gemini-query-assistance';
import { enforcePhoneRequirement } from './phone-requirement';
import { noUsableResultsWarning } from './search-finalization';
import { mergeLinkedInWithPublicListings } from './public-entity-matching';
import { getLeadDiscoveryCandidateTarget } from './lead-discovery-budget';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { buildDiscoverySeeds } from './discovery-seeds';
import {
  buildSearchExecutionContract,
  buildSearchResponseContract,
} from '../../../shared/search-contract';
import { normalizeLeadSourceMode } from './search-source-mode';
import { buildLeadQualitySummary } from './quality-summary';
import { filterLeadsForLocation } from './location-acceptance';
import {
  discoverUsLeadsFromNotaryCafeIndex,
  isNotaryCafeCategory,
  prioritizeAiLeadSources,
  type NotaryCafeDiscoveryResult,
} from './notarycafe-search';

export type AiDiscoveryResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  coverage: ProviderCoverage[];
  aiAssistance: 'enabled' | 'disabled' | 'failed' | 'rate_limited';
  researchCandidates: ResearchCandidate[];
  publicCoverage?: LinkedInDiscoveryResult['coverage'];
  enrichedCount: number;
};

type AiDiscoveryDeps = {
  discoverLinkedin?: typeof discoverUsLeadsFromLinkedinSearch;
  discoverPublicListings?: typeof discoverUsLeadsFromOsm;
  discoverGmbListings?: typeof discoverUsLeadsFromOsm;
  enrichPublicContacts?: typeof enrichLinkedinLeadsWithPublicContacts;
  expandQuery?: typeof expandQueryWithGemini;
  discoverGemini?: typeof discoverGeminiResearch;
  discoverNotaryCafe?: typeof discoverUsLeadsFromNotaryCafeIndex;
};

const discoveryWindowMs = 24_000;
const contactEnrichmentWindowMs = 18_000;
const maxGeminiListingSeeds = 40;
const maxAiGmbCandidates = 500;
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

const buildCoverage = (gmbConfigured = false, notaryCafeConfigured = false): ProviderCoverage[] => {
  const geminiKeyCount = getGeminiApiKeyCount();
  const geminiKeySummary = geminiKeyCount > 1
    ? `${geminiKeyCount} Gemini API keys are pooled and rotated across healthy requests.`
    : 'A Gemini API key is configured for public research.';

  return [
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
      ? 'Priority source for notary requests: search-indexed public NotaryCafe profile references are merged into the same phone-evidence and deduplication pipeline. Direct page access, login, CAPTCHA, Cloudflare, and geo-block bypasses are disabled.'
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
    providerName: 'Gemini search planning',
    status: isGeminiQueryAssistanceEnabled() ? 'configured' : 'not_configured',
    leadCount: 0,
    message: isGeminiQueryAssistanceEnabled()
      ? `${geminiKeySummary} Gemini expands multiple public search lenses; public sources and deterministic checks decide what becomes a lead.`
      : 'Gemini is not configured; deterministic local category and role expansion continues.',
  },
  {
    providerId: 'gemini-public-discovery',
    providerName: 'Gemini public discovery',
    status: isGeminiLeadDiscoveryEnabled() ? 'configured' : 'not_configured',
    leadCount: 0,
    message: isGeminiLeadDiscoveryEnabled()
      ? `${geminiKeySummary} Grounded public-web candidates are retained for review; only public phone evidence makes a lead exportable.`
      : 'Grounded public discovery is unavailable until Gemini is configured.',
  },
  {
    providerId: 'gemini-listing-enrichment',
    providerName: 'Gemini listing enrichment',
    status: isGeminiLeadDiscoveryEnabled() ? 'configured' : 'not_configured',
    leadCount: 0,
    message: isGeminiLeadDiscoveryEnabled()
      ? `${geminiKeySummary} Gemini enriches public business listing seeds with publicly evidenced company and decision-maker details.`
      : 'Gemini listing enrichment is unavailable until Gemini is configured.',
  },
  ];
};

const updateCoverage = (
  coverage: ProviderCoverage[],
  providerId: string,
  patch: Partial<ProviderCoverage>,
) => {
  const entry = coverage.find((item) => item.providerId === providerId);
  if (entry) {
    Object.assign(entry, patch);
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

const mergeLinkedInDiscoveryResults = (
  base: LinkedInDiscoveryResult,
  incoming: LinkedInDiscoveryResult,
): LinkedInDiscoveryResult => {
  const leads = deduplicateLeads([...base.leads, ...incoming.leads]);
  const warnings = [...base.warnings];
  for (const warning of incoming.warnings) {
    addWarning(warnings, warning);
  }

  const baseCoverage = base.coverage;
  const incomingCoverage = incoming.coverage;
  const coverage = baseCoverage || incomingCoverage
    ? {
        queriesAttempted:
          (baseCoverage?.queriesAttempted ?? 0) + (incomingCoverage?.queriesAttempted ?? 0),
        providersChecked: Math.max(
          baseCoverage?.providersChecked ?? 0,
          incomingCoverage?.providersChecked ?? 0,
        ),
        providersPaused: Math.max(
          baseCoverage?.providersPaused ?? 0,
          incomingCoverage?.providersPaused ?? 0,
        ),
        acceptedCandidates: leads.length,
        queryFamilies: [
          ...new Set([
            ...(baseCoverage?.queryFamilies ?? []),
            ...(incomingCoverage?.queryFamilies ?? []),
          ]),
        ],
        queryFamilyCounts: [baseCoverage?.queryFamilyCounts, incomingCoverage?.queryFamilyCounts]
          .filter((counts): counts is Record<string, number> => Boolean(counts))
          .reduce<Record<string, number>>((merged, counts) => {
            for (const [family, count] of Object.entries(counts)) {
              merged[family] = (merged[family] ?? 0) + count;
            }
            return merged;
          }, {}),
      }
    : undefined;

  return {
    leads,
    warnings,
    blocked: base.blocked && incoming.blocked,
    ...(coverage ? { coverage } : {}),
  };
};

export const createAiLeadDiscovery = (deps: AiDiscoveryDeps = {}) => {
  const discoverLinkedin = deps.discoverLinkedin ?? discoverUsLeadsFromLinkedinSearch;
  const discoverPublicListings = deps.discoverPublicListings;
  const discoverGmbListings = deps.discoverGmbListings;
  const enrichPublicContacts =
    deps.enrichPublicContacts ?? enrichLinkedinLeadsWithPublicContacts;
  const expandQuery = deps.expandQuery ?? expandQueryWithGemini;
  const discoverGemini = deps.discoverGemini ?? discoverGeminiResearch;
  const discoverNotaryCafe =
    deps.discoverNotaryCafe ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromNotaryCafeIndex);

  return async ({
    request,
    location,
    deadlineMs = Date.now() + discoveryWindowMs + contactEnrichmentWindowMs,
  }: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    deadlineMs?: number;
  }): Promise<AiDiscoveryResult> => {
    const warnings: ProviderWarning[] = [
      {
        providerId: 'ai-mode-policy',
        providerName: 'AI mode',
        message: freeAiModePolicy,
      },
    ];
    const coverage = buildCoverage(Boolean(discoverGmbListings), Boolean(discoverNotaryCafe));
    let aiAssistance: AiDiscoveryResult['aiAssistance'] = 'disabled';
    let researchCandidates: ResearchCandidate[] = [];
    let geminiDiscoveryFailed = false;
    let geminiDiscoveryRateLimited = false;
    let queryHints: string[] = request.researchBrief?.trim()
      ? [request.researchBrief.trim()]
      : [];

    const discoveryDeadlineMs = Math.min(
      deadlineMs,
      Date.now() + getAiDiscoveryWindowMs(request.count),
    );
    const geminiLocationContext = buildGeminiLocationContext(location);

    const gmbListingPromise = discoverGmbListings
      ? withTimeout(
          discoverGmbListings({
            request: {
              companyType: request.companyType,
              count: request.count,
            },
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
            updateCoverage(coverage, 'google-places-ai', {
              status: 'returned',
              leadCount: leads.length,
              message: 'Google Business (GMB) listing companies were passed to Gemini for public enrichment.',
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
              message:
                error instanceof Error
                  ? error.message
                  : 'Google Business listing discovery failed.',
            });
            return [];
          })
      : Promise.resolve([] as Lead[]);

    const publicListingPromise = discoverPublicListings
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
            updateCoverage(coverage, 'public-business-listings', {
              status: 'returned',
              leadCount: leads.length,
              message: 'Free public business listings were merged with public discovery results.',
            });
            return leads;
          })
          .catch((error): Lead[] => {
            addWarning(warnings, {
              providerId: 'public-business-listings',
              providerName: 'Public Business Listings',
              message:
                error instanceof Error
                  ? `${error.message} Other public results were preserved.`
                  : 'Public business-listing discovery failed. Other public results were preserved.',
            });
            updateCoverage(coverage, 'public-business-listings', {
              status: isTimeoutFailure(error) ? 'partial' : 'failed',
              message:
                error instanceof Error ? error.message : 'Public business-listing discovery failed.',
            });
            return [];
          })
      : Promise.resolve([] as Lead[]);

    const notaryCafeApplicable = isNotaryCafeCategory(request.companyType);
    if (discoverNotaryCafe && !notaryCafeApplicable) {
      updateCoverage(coverage, 'notarycafe-indexed-search', {
        status: 'configured',
        leadCount: 0,
        message: 'Indexed NotaryCafe search was skipped because the requested category is not notary-related; unrelated profiles cannot enter this search.',
      });
    }
    const notaryCafePromise: Promise<Lead[]> = discoverNotaryCafe && notaryCafeApplicable
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
            for (const warning of result.warnings) addWarning(warnings, warning);
            updateCoverage(coverage, 'notarycafe-indexed-search', {
              status: result.leads.length ? 'returned' : 'configured',
              leadCount: result.leads.length,
              message: result.leads.length
                ? `Priority indexed NotaryCafe evidence returned ${result.leads.length} phone-qualified candidate${result.leads.length === 1 ? '' : 's'}; direct page access was not attempted.`
                : 'No phone-qualified NotaryCafe profile references were returned by the public search index.',
            });
            return result.leads;
          })
          .catch((error): Lead[] => {
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
              message,
            });
            return [];
          })
      : Promise.resolve([] as Lead[]);

    // A search used to make one grounded Gemini request immediately and then a
    // second grounded request for listing enrichment. That doubled free-tier
    // pressure. Wait for the best public listing seeds and fold them into one
    // grounded pass instead; deterministic sources still run independently.
    const geminiDiscoveryPromise: Promise<GeminiResearchDiscovery> = isGeminiLeadDiscoveryEnabled()
      ? (async () => {
          const listingLeads = discoverGmbListings
            ? await gmbListingPromise.then((gmbLeads) =>
                gmbLeads.length ? gmbLeads : publicListingPromise,
              )
            : await publicListingPromise;
          const listingSeeds = selectListingSeeds(listingLeads);

          if (listingSeeds.length) {
            updateCoverage(coverage, 'gemini-listing-enrichment', {
              status: 'configured',
              message: `Public listing seeds will be included in the single Gemini research pass (${listingSeeds.length} selected).`,
            });
          }

          if (isGeminiRateLimited()) {
            geminiDiscoveryFailed = true;
            geminiDiscoveryRateLimited = true;
            updateCoverage(coverage, 'gemini-public-discovery', {
              status: 'partial',
              message: 'Gemini is cooling down after a free-tier rate-limit response; deterministic public discovery continued.',
            });
            if (listingSeeds.length) {
              updateCoverage(coverage, 'gemini-listing-enrichment', {
                status: 'partial',
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
                message,
              });
              return emptyGeminiResearch();
            }

            const requestTimeoutMs = Math.min(geminiDiscoveryTimeoutMs, remainingGeminiMs);
            const grounded = await withTimeout(
              discoverGemini(
                request,
                location.label,
                listingSeeds,
                geminiLocationContext,
                requestTimeoutMs,
              ),
              Math.min(discoveryDeadlineMs, Date.now() + requestTimeoutMs),
              'Gemini public discovery timed out; deterministic public sources were preserved.',
            );
            updateCoverage(coverage, 'gemini-listing-enrichment', {
              status: listingSeeds.length ? 'returned' : 'configured',
              leadCount: listingSeeds.length ? grounded.candidates.length : 0,
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
              severity: 'warning',
            });
            updateCoverage(coverage, 'gemini-public-discovery', {
              status: timedOut || rateLimited ? 'partial' : 'failed',
              message,
            });
            if (listingSeeds.length) {
              updateCoverage(coverage, 'gemini-listing-enrichment', {
                status: timedOut || rateLimited ? 'partial' : 'failed',
                message: rateLimited
                  ? 'Gemini listing enrichment was skipped after the free-tier limit; original public listing fields and phones remain available.'
                  : 'The single Gemini pass could not enrich the public listing seeds; original listing fields remain available.',
              });
            }
            return emptyGeminiResearch();
          }
        })()
      : Promise.resolve(emptyGeminiResearch());

    const baselineQueryHints = [...queryHints];
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
        updateCoverage(coverage, 'linkedin-public-search', {
          status: result.blocked ? 'failed' : 'returned',
          leadCount: result.leads.length,
          message: result.blocked
            ? 'Public search providers were blocked or rate-limited; no unverified profiles were added.'
            : 'Public LinkedIn profile results were matched and deduplicated.',
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
        });
        updateCoverage(coverage, 'linkedin-public-search', {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Public discovery failed.',
        });
        return {
          result: { leads: [], warnings: [], blocked: false },
          timedOut: isTimeoutFailure(error),
        };
      }
    };

    // Start deterministic discovery before Gemini planning resolves. Gemini
    // improves recall, but it must never sit in front of the reliable public
    // path or consume the entire discovery window on a free-tier 429/timeout.
    const linkedinDiscoveryPromise = runLinkedinDiscovery(baselineQueryHints);
    const assistancePromise = runGeminiQueryAssistance({
      request,
      locationLabel: location.label,
      seedHints: baselineQueryHints,
      deadlineMs,
      expandQuery,
    });

    const [assistance, baselineDiscovery] = await Promise.all([
      assistancePromise,
      linkedinDiscoveryPromise,
    ]);
    queryHints = assistance.queryHints;
    aiAssistance = assistance.aiAssistance;
    updateCoverage(coverage, 'gemini-query-assistance', assistance.coverage);
    if (assistance.warning) addWarning(warnings, assistance.warning);

    let discoveryResult = baselineDiscovery.result;
    const baselineHintKeys = new Set(
      baselineQueryHints.map((hint) => hint.trim().toLowerCase()).filter(Boolean),
    );
    const hasNewAssistedHints = assistance.aiAssistance === 'enabled' && assistance.queryHints.some(
      (hint) => !baselineHintKeys.has(hint.trim().toLowerCase()),
    );
    const shouldRunAssistedFallback = hasNewAssistedHints &&
      !baselineDiscovery.timedOut &&
      !discoveryResult.blocked &&
      discoveryResult.leads.length < getLeadDiscoveryCandidateTarget(request.count, 1) &&
      Date.now() + 1_000 < discoveryDeadlineMs;
    let assistedFallbackRan = false;

    if (shouldRunAssistedFallback) {
      const assistedDiscovery = await runLinkedinDiscovery(
        queryHints,
        { ...request, researchDepth: 'quick' },
      );
      assistedFallbackRan = true;
      discoveryResult = mergeLinkedInDiscoveryResults(discoveryResult, assistedDiscovery.result);
      updateCoverage(coverage, 'linkedin-public-search', {
        status: discoveryResult.blocked ? 'failed' : 'returned',
        leadCount: discoveryResult.leads.length,
        message: 'Deterministic public discovery ran first; a bounded Gemini-assisted query pass added recall coverage.',
      });
    }

    const [publicListingLeads, gmbListingLeads, geminiResult, notaryCafeLeads] = await Promise.all([
      publicListingPromise,
      gmbListingPromise,
      geminiDiscoveryPromise,
      notaryCafePromise,
    ]);
    if (geminiDiscoveryRateLimited && aiAssistance === 'disabled') {
      aiAssistance = 'rate_limited';
    }

    const filterLocationSafely = (leads: Lead[]) => leads.filter((lead) => {
      try {
        return filterLeadsForLocation([lead], location).length > 0;
      } catch {
        // A malformed persisted/provider record must never widen the search
        // geography or break the rest of the provider fusion run.
        return false;
      }
    });
    const scopedLinkedinLeads = filterLocationSafely(discoveryResult.leads);
    const scopedGeminiLeads = filterLocationSafely(geminiResult.leads);
    const scopedGmbListingLeads = filterLocationSafely(gmbListingLeads);
    const scopedPublicListingLeads = filterLocationSafely(publicListingLeads);
    const scopedNotaryCafeLeads = filterLocationSafely(notaryCafeLeads);
    const excludedForLocation =
      discoveryResult.leads.length - scopedLinkedinLeads.length +
      geminiResult.leads.length - scopedGeminiLeads.length +
      gmbListingLeads.length - scopedGmbListingLeads.length +
      publicListingLeads.length - scopedPublicListingLeads.length +
      notaryCafeLeads.length - scopedNotaryCafeLeads.length;

    if (excludedForLocation > 0) {
      addWarning(warnings, {
        providerId: 'location-acceptance',
        providerName: 'Deterministic location acceptance',
        message: `Excluded ${excludedForLocation} provider result${excludedForLocation === 1 ? '' : 's'} without a deterministic match for ${location.label}; no out-of-area record was promoted.`,
        severity: 'info',
      });
    }
    updateCoverage(coverage, 'linkedin-public-search', {
      leadCount: scopedLinkedinLeads.length,
      message: assistedFallbackRan
        ? 'Deterministic public discovery ran first; a bounded Gemini-assisted query pass added recall coverage and location-checked results.'
        : `Public LinkedIn profile results were matched, location-checked, and deduplicated.${scopedLinkedinLeads.length < discoveryResult.leads.length ? ' Out-of-area results were excluded.' : ''}`,
    });
    updateCoverage(coverage, 'google-places-ai', {
      leadCount: scopedGmbListingLeads.length,
    });
    updateCoverage(coverage, 'public-business-listings', {
      leadCount: scopedPublicListingLeads.length,
    });
    updateCoverage(coverage, 'notarycafe-indexed-search', {
      leadCount: scopedNotaryCafeLeads.length,
    });

    researchCandidates = geminiResult.candidates;
    updateCoverage(coverage, 'gemini-public-discovery', {
      status: !isGeminiLeadDiscoveryEnabled()
        ? 'not_configured'
        : geminiDiscoveryFailed
          ? 'partial'
          : 'returned',
      leadCount: researchCandidates.length,
      message: !isGeminiLeadDiscoveryEnabled()
        ? 'Grounded Gemini public discovery was not configured.'
        : geminiDiscoveryRateLimited
          ? 'Gemini free-tier quota or rate limit was reached; deterministic public sources and original listing fields were preserved.'
        : geminiDiscoveryFailed
          ? 'Gemini public discovery was not fully available; public candidates from other sources were preserved.'
          : `Retained ${researchCandidates.length} Gemini public research candidate${researchCandidates.length === 1 ? '' : 's'}; candidates remain visible even when phone validation excludes them from export.`,
    });

    const publicBusinessListingLeads = [
      ...scopedNotaryCafeLeads,
      ...scopedGmbListingLeads,
      ...scopedPublicListingLeads,
    ];
    let leads = deduplicateLeads(
      mergeLinkedInWithPublicListings(
        [...scopedLinkedinLeads, ...scopedGeminiLeads],
        publicBusinessListingLeads,
      ).map(enrichLead),
    );
    leads = prioritizeAiLeadSources(leads);
    let enrichedCount = 0;

    if (leads.length && Date.now() < deadlineMs) {
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
          leadCount: enrichedCount,
          message: 'Public websites were checked for openly listed business contact details.',
        });
      } catch (error) {
        addWarning(warnings, {
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          message:
            error instanceof Error
              ? `${error.message} Public profiles were preserved; contact fields may be incomplete.`
              : 'Public website enrichment failed. Public profiles were preserved; contact fields may be incomplete.',
        });
        updateCoverage(coverage, 'public-website-enrichment', {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Public website enrichment failed.',
        });
      }
    }

    if (!discoveryResult.leads.length && discoveryResult.blocked) {
      addWarning(warnings, {
        providerId: 'linkedin-public-search',
        providerName: 'Public LinkedIn Search',
        message:
          'Free public search providers were blocked or rate-limited. No unverified or fabricated leads were added.',
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
      publicCoverage: discoveryResult.coverage,
      enrichedCount,
    };
  };
};

export const discoverUsLeadsFromAiMode = createAiLeadDiscovery(
  process.env.NODE_ENV === 'test'
    ? {}
    : {
        discoverPublicListings: discoverUsLeadsFromOsm,
        discoverNotaryCafe: discoverUsLeadsFromNotaryCafeIndex,
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
