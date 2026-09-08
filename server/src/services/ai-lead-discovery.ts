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
  isGeminiQueryAssistanceEnabled,
  isGeminiLeadDiscoveryEnabled,
} from '../providers/gemini';
import {
  discoverGeminiResearch,
  mergeGroundingSources,
  mergeResearchCandidates,
  type GeminiResearchDiscovery,
} from './gemini-lead-discovery';
import { runGeminiQueryAssistance } from './gemini-query-assistance';
import { enforcePhoneRequirement } from './phone-requirement';
import { noUsableResultsWarning } from './search-finalization';
import { mergeLinkedInWithPublicListings } from './public-entity-matching';
import { getLeadDiscoveryCandidateTarget } from './lead-discovery-budget';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import {
  buildSearchExecutionContract,
  buildSearchResponseContract,
} from '../../../shared/search-contract';
import { normalizeLeadSourceMode } from './search-source-mode';
import { buildLeadQualitySummary } from './quality-summary';

export type AiDiscoveryResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  coverage: ProviderCoverage[];
  aiAssistance: 'enabled' | 'disabled' | 'failed';
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
};

const discoveryWindowMs = 24_000;
const contactEnrichmentWindowMs = 18_000;
const geminiListingEnrichmentWindowMs = 8_000;
const maxGeminiListingSeeds = 40;
const maxAiGmbCandidates = 500;
const getAiDiscoveryWindowMs = (requestedCount: number) =>
  requestedCount >= 100 ? 32_000 : discoveryWindowMs;
const getAiGmbSearchQueryLimit = (requestedCount: number) =>
  Math.min(16, Math.max(3, Math.ceil(Math.max(50, requestedCount) / 50) + 2));
// Keep the orchestration budget at least as large as Gemini's grounded request
// budget so the wrapper does not discard a response that the provider is still
// allowed to finish.
const geminiDiscoveryTimeoutMs = 20_000;
const withTimeout = async <T>(promise: Promise<T>, deadlineMs: number, message: string) => {
  const remainingMs = Math.max(1_000, deadlineMs - Date.now());
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

const buildCoverage = (gmbConfigured = false): ProviderCoverage[] => [
  ...salesProviderAudits.map((provider) => ({
    providerId: `${provider.id}-audit`,
    providerName: provider.name,
    status: 'not_configured' as const,
    leadCount: 0,
    message: provider.limitation,
  })),
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
      ? 'Gemini expands multiple public search lenses; public sources and deterministic checks decide what becomes a lead.'
      : 'Gemini is not configured; deterministic local category and role expansion continues.',
  },
  {
    providerId: 'gemini-public-discovery',
    providerName: 'Gemini public discovery',
    status: isGeminiLeadDiscoveryEnabled() ? 'configured' : 'not_configured',
    leadCount: 0,
    message: isGeminiLeadDiscoveryEnabled()
      ? 'Grounded public-web candidates are retained for review; only public phone evidence makes a lead exportable.'
      : 'Grounded public discovery is unavailable until Gemini is configured.',
  },
  {
    providerId: 'gemini-listing-enrichment',
    providerName: 'Gemini listing enrichment',
    status: isGeminiLeadDiscoveryEnabled() ? 'configured' : 'not_configured',
    leadCount: 0,
    message: isGeminiLeadDiscoveryEnabled()
      ? 'Gemini enriches public business listing seeds with publicly evidenced company and decision-maker details.'
      : 'Gemini listing enrichment is unavailable until Gemini is configured.',
  },
];

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
  const query = `${request.companyType} in ${location.label}`;

  return googlePlacesProvider.fetchLeads({
    rawQuery: query,
    query,
    queryVariants: buildDiscoveryQueryVariants(
      request.companyType,
      location,
      profile,
    ).slice(0, 12),
    request: googleRequest,
    location,
    deadlineMs,
    maxLeadCount: Math.min(Math.max(request.count, 20), maxAiGmbCandidates),
    maxSearchQueries: getAiGmbSearchQueryLimit(request.count),
    // Two concurrent public query paths improve recall for larger requests
    // without opening an unbounded request fan-out that would trigger throttling.
    maxConcurrentSearches: request.count >= 100 ? 2 : 1,
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

export const createAiLeadDiscovery = (deps: AiDiscoveryDeps = {}) => {
  const discoverLinkedin = deps.discoverLinkedin ?? discoverUsLeadsFromLinkedinSearch;
  const discoverPublicListings = deps.discoverPublicListings;
  const discoverGmbListings = deps.discoverGmbListings;
  const enrichPublicContacts =
    deps.enrichPublicContacts ?? enrichLinkedinLeadsWithPublicContacts;
  const expandQuery = deps.expandQuery ?? expandQueryWithGemini;
  const discoverGemini = deps.discoverGemini ?? discoverGeminiResearch;

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
    const coverage = buildCoverage(Boolean(discoverGmbListings));
    let aiAssistance: AiDiscoveryResult['aiAssistance'] = 'disabled';
    let researchCandidates: ResearchCandidate[] = [];
    let geminiDiscoveryFailed = false;
    let geminiListingEnrichmentFailed = false;
    let geminiListingEnrichmentTimedOut = false;
    let queryHints: string[] = request.researchBrief?.trim()
      ? [request.researchBrief.trim()]
      : [];

    const discoveryDeadlineMs = Math.min(
      deadlineMs,
      Date.now() + getAiDiscoveryWindowMs(request.count),
    );
    // Gemini's candidate search does not depend on the query-lens response, so
    // start it immediately and keep it independent from LinkedIn's timeout.
    const geminiDiscoveryPromise: Promise<GeminiResearchDiscovery> = isGeminiLeadDiscoveryEnabled()
        ? withTimeout(
          discoverGemini(request, location.label),
          Math.min(discoveryDeadlineMs, Date.now() + geminiDiscoveryTimeoutMs),
          'Gemini public discovery timed out; other public sources were preserved.',
        ).catch((error): GeminiResearchDiscovery => {
          geminiDiscoveryFailed = true;
          addWarning(warnings, {
            providerId: 'gemini-public-discovery',
            providerName: 'Gemini public discovery',
            message:
              error instanceof Error
                ? `${error.message} Gemini candidates were not available for this search.`
                : 'Gemini public discovery failed. Other public sources were preserved.',
            severity: 'warning',
          });
          updateCoverage(coverage, 'gemini-public-discovery', {
            status: isTimeoutFailure(error) ? 'partial' : 'failed',
            message: error instanceof Error ? error.message : 'Gemini public discovery failed.',
          });
          return { candidates: [], groundingSources: [], leads: [] };
        })
      : Promise.resolve({ candidates: [], groundingSources: [], leads: [] });

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

    const enrichListingSeedsWithGemini = async (listingLeads: Lead[]) => {
      const listingSeeds = selectListingSeeds(listingLeads);
      if (!listingSeeds.length) {
        updateCoverage(coverage, 'gemini-listing-enrichment', {
          status: 'configured',
          message: 'No public business listing seeds were available for the Gemini enrichment pass.',
        });
        return emptyGeminiResearch();
      }

      try {
        const listingEnrichment = await withTimeout(
          discoverGemini(request, location.label, listingSeeds),
          Math.min(discoveryDeadlineMs, Date.now() + geminiListingEnrichmentWindowMs),
          'Gemini listing enrichment timed out; original business listing fields were preserved.',
        );
        updateCoverage(coverage, 'gemini-listing-enrichment', {
          status: 'returned',
          leadCount: listingEnrichment.candidates.length,
          message: `Gemini enriched ${listingSeeds.length} public business listing seed${listingSeeds.length === 1 ? '' : 's'}; original listing fields remain preserved.`,
        });
        return listingEnrichment;
      } catch (error) {
        const timedOut = isTimeoutFailure(error);
        const rateLimited = isRateLimitFailure(error);
        geminiListingEnrichmentFailed = true;
        geminiListingEnrichmentTimedOut = timedOut;
        addWarning(warnings, {
          providerId: 'gemini-listing-enrichment',
          providerName: 'Gemini listing enrichment',
          message:
            rateLimited
              ? 'Gemini free-tier quota or rate limit was reached; original Google Business listing fields and public phones were preserved.'
              : error instanceof Error
                ? `${error.message} Original Google Business listing fields were preserved.`
                : 'Gemini listing enrichment failed. Original business listing fields were preserved.',
          severity: 'warning',
        });
        updateCoverage(coverage, 'gemini-listing-enrichment', {
          status: timedOut || rateLimited ? 'partial' : 'failed',
          message:
            rateLimited
              ? 'Free Gemini quota or rate limit reached; original GMB company details and public phones remain available.'
              : error instanceof Error
                ? error.message
                : 'Gemini listing enrichment failed.',
        });
        return emptyGeminiResearch();
      }
    };

    // Start the seeded Gemini pass as soon as GMB returns so a slow LinkedIn
    // or OSM branch cannot consume the window reserved for enrichment.
    const geminiListingEnrichmentPromise: Promise<GeminiResearchDiscovery> = isGeminiLeadDiscoveryEnabled()
      ? discoverGmbListings
        ? gmbListingPromise.then(async (gmbLeads) => {
            if (selectListingSeeds(gmbLeads).length) {
              return enrichListingSeedsWithGemini(gmbLeads);
            }

            return enrichListingSeedsWithGemini(await publicListingPromise);
          })
        : publicListingPromise.then(enrichListingSeedsWithGemini)
      : Promise.resolve(emptyGeminiResearch());

    const assistance = await runGeminiQueryAssistance({
      request,
      locationLabel: location.label,
      seedHints: queryHints,
      deadlineMs,
      expandQuery,
    });
    queryHints = assistance.queryHints;
    aiAssistance = assistance.aiAssistance;
    updateCoverage(coverage, 'gemini-query-assistance', assistance.coverage);
    if (assistance.warning) addWarning(warnings, assistance.warning);

    // Run independent free sources together so a slow LinkedIn provider does
    // not consume the entire window before other providers get a chance to return phones.
    const linkedinDiscoveryPromise = withTimeout(
      discoverLinkedin({
        request,
        location,
        queryHints,
        deadlineMs: discoveryDeadlineMs,
      }),
      discoveryDeadlineMs,
      'Free public discovery timed out before the batch completed.',
    )
      .then((result) => {
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
        return result;
      })
      .catch((error): LinkedInDiscoveryResult => {
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
        return { leads: [], warnings: [], blocked: false };
      });

    const [discoveryResult, publicListingLeads, gmbListingLeads, initialGeminiResult, listingGeminiResult] = await Promise.all([
      linkedinDiscoveryPromise,
      publicListingPromise,
      gmbListingPromise,
      geminiDiscoveryPromise,
      geminiListingEnrichmentPromise,
    ]);

    const geminiResult = {
      candidates: mergeResearchCandidates([
        ...initialGeminiResult.candidates,
        ...listingGeminiResult.candidates,
      ]),
      groundingSources: mergeGroundingSources([
        ...initialGeminiResult.groundingSources,
        ...listingGeminiResult.groundingSources,
      ]),
      leads: [...initialGeminiResult.leads, ...listingGeminiResult.leads],
    };

    researchCandidates = geminiResult.candidates;
    updateCoverage(coverage, 'gemini-public-discovery', {
      status: !isGeminiLeadDiscoveryEnabled()
        ? 'not_configured'
        : geminiDiscoveryFailed || geminiListingEnrichmentFailed
          ? 'partial'
          : 'returned',
      leadCount: researchCandidates.length,
      message: !isGeminiLeadDiscoveryEnabled()
        ? 'Grounded Gemini public discovery was not configured.'
        : geminiDiscoveryFailed || geminiListingEnrichmentFailed
          ? 'Gemini public discovery or listing enrichment was not fully available; public candidates from other sources were preserved.'
          : `Retained ${researchCandidates.length} Gemini public research candidate${researchCandidates.length === 1 ? '' : 's'}; candidates remain visible even when phone validation excludes them from export.`,
    });

    const publicBusinessListingLeads = [...gmbListingLeads, ...publicListingLeads];
    let leads = deduplicateLeads(
      mergeLinkedInWithPublicListings(
        [...discoveryResult.leads, ...geminiResult.leads],
        publicBusinessListingLeads,
      ).map(enrichLead),
    );
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
        leads = deduplicateLeads(contactResult.leads.map(enrichLead));
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
      leads: leads.slice(0, getLeadDiscoveryCandidateTarget(request.count, 3)),
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
  const visibleLeads = phoneRequirement.leads.slice(0, request.count);
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
