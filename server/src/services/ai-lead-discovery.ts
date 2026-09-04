import { randomUUID } from 'node:crypto';

import type { Lead } from '../types/lead';
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
import {
  expandQueryWithGemini,
  isGeminiQueryAssistanceEnabled,
} from '../providers/gemini';
import { enforcePhoneRequirement } from './phone-requirement';
import { noUsableResultsWarning } from './search-finalization';
import { mergeLinkedInWithPublicListings } from './public-entity-matching';

export type AiDiscoveryResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  coverage: ProviderCoverage[];
  aiAssistance: 'enabled' | 'disabled' | 'failed';
  publicCoverage?: LinkedInDiscoveryResult['coverage'];
  enrichedCount: number;
};

type AiDiscoveryDeps = {
  discoverLinkedin?: typeof discoverUsLeadsFromLinkedinSearch;
  discoverPublicListings?: typeof discoverUsLeadsFromOsm;
  enrichPublicContacts?: typeof enrichLinkedinLeadsWithPublicContacts;
  expandQuery?: typeof expandQueryWithGemini;
};

const discoveryWindowMs = 24_000;
const contactEnrichmentWindowMs = 12_000;
const queryAssistanceWindowMs = 8_000;

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

const buildCoverage = (): ProviderCoverage[] => [
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
    providerId: 'gemini-query-assistance',
    providerName: 'Gemini query assistance',
    status: isGeminiQueryAssistanceEnabled() ? 'configured' : 'not_configured',
    leadCount: 0,
    message: isGeminiQueryAssistanceEnabled()
      ? 'Optional user-configured query wording only; Gemini is not a lead or contact source.'
      : 'Disabled by default; requires a user-provided key and explicit opt-in.',
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

export const createAiLeadDiscovery = (deps: AiDiscoveryDeps = {}) => {
  const discoverLinkedin = deps.discoverLinkedin ?? discoverUsLeadsFromLinkedinSearch;
  const discoverPublicListings = deps.discoverPublicListings;
  const enrichPublicContacts =
    deps.enrichPublicContacts ?? enrichLinkedinLeadsWithPublicContacts;
  const expandQuery = deps.expandQuery ?? expandQueryWithGemini;

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
    const coverage = buildCoverage();
    let aiAssistance: AiDiscoveryResult['aiAssistance'] = 'disabled';
    let queryHints: string[] = request.researchBrief?.trim()
      ? [request.researchBrief.trim()]
      : [];

    if (isGeminiQueryAssistanceEnabled()) {
      const rawQuery = `${request.companyType} in ${location.label}`;

      try {
        const assistedQuery = await withTimeout(
          expandQuery(rawQuery, request),
          Math.min(deadlineMs, Date.now() + queryAssistanceWindowMs),
          'Gemini query assistance timed out; local public query expansion continued.',
        );
        const normalizedAssistedQuery = assistedQuery.trim().slice(0, 180);

        if (normalizedAssistedQuery && normalizedAssistedQuery.toLowerCase() !== rawQuery.toLowerCase()) {
          queryHints = [...queryHints, normalizedAssistedQuery];
        }

        aiAssistance = 'enabled';
        updateCoverage(coverage, 'gemini-query-assistance', {
          status: 'returned',
          message: 'Gemini expanded search wording only; public providers supplied the results.',
        });
      } catch (error) {
        aiAssistance = 'failed';
        addWarning(warnings, {
          providerId: 'gemini-query-assistance',
          providerName: 'Gemini query assistance',
          message:
            error instanceof Error
              ? `${error.message} Local public query expansion continued.`
              : 'Gemini query assistance failed. Local public query expansion continued.',
        });
        updateCoverage(coverage, 'gemini-query-assistance', {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Gemini query assistance failed.',
        });
      }
    }
    // Run independent free sources together so a slow LinkedIn provider does
    // not consume the entire window before OSM gets a chance to return phones.
    const discoveryDeadlineMs = Math.min(deadlineMs, Date.now() + discoveryWindowMs);
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

    const publicListingPromise = discoverPublicListings
      ? withTimeout(
          discoverPublicListings({
            request: {
              companyType: request.companyType,
              count: Math.min(Math.max(request.count * 2, 50), 180),
            },
            location,
            profile: resolveCategoryProfile(request.companyType),
            deadlineMs: discoveryDeadlineMs,
          }),
          discoveryDeadlineMs,
          'Public business-listing discovery timed out; LinkedIn results were preserved.',
        )
          .then((leads) => {
            updateCoverage(coverage, 'public-business-listings', {
              status: 'returned',
              leadCount: leads.length,
              message: 'Free public business listings were merged with public LinkedIn results.',
            });
            return leads;
          })
          .catch((error): Lead[] => {
            addWarning(warnings, {
              providerId: 'public-business-listings',
              providerName: 'Public Business Listings',
              message:
                error instanceof Error
                  ? `${error.message} LinkedIn results were preserved.`
                  : 'Public business-listing discovery failed. LinkedIn results were preserved.',
            });
            updateCoverage(coverage, 'public-business-listings', {
              status: 'failed',
              message:
                error instanceof Error ? error.message : 'Public business-listing discovery failed.',
            });
            return [];
          })
      : Promise.resolve([] as Lead[]);

    const [discoveryResult, publicListingLeads] = await Promise.all([
      linkedinDiscoveryPromise,
      publicListingPromise,
    ]);

    let leads = deduplicateLeads(
      mergeLinkedInWithPublicListings(discoveryResult.leads, publicListingLeads).map(enrichLead),
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
      leads: leads.slice(0, request.count),
      warnings,
      coverage,
      aiAssistance,
      publicCoverage: discoveryResult.coverage,
      enrichedCount,
    };
  };
};

export const discoverUsLeadsFromAiMode = createAiLeadDiscovery(
  process.env.NODE_ENV === 'test'
    ? {}
    : { discoverPublicListings: discoverUsLeadsFromOsm },
);

const buildResponse = ({
  searchId,
  request,
  locationLabel,
  result,
}: {
  searchId: string;
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

  return {
    searchId,
    leads: visibleLeads,
    meta: {
      query: `${request.companyType} in ${locationLabel}`,
      locationLabel,
      researchDepth: request.researchDepth ?? 'verified',
      researchBrief: request.researchBrief,
      status,
      progress: {
        discovered: visibleLeads.length,
        enriched: result.enrichedCount,
        publicContactsFound: visibleLeads.filter((lead) => lead.hasEmail || lead.hasPhone).length,
        phoneExcludedCount: phoneRequirement.excludedCount,
        publicQueriesAttempted: result.publicCoverage?.queriesAttempted,
        publicProvidersChecked: result.publicCoverage?.providersChecked,
        publicQueryFamilies: result.publicCoverage?.queryFamilies,
        publicQueryFamilyCounts: result.publicCoverage?.queryFamilyCounts,
        providerCoverage: result.coverage,
        aiAssistance: result.aiAssistance,
        totalCandidates: visibleLeads.length,
        requestedCount: request.count,
        foundCount: visibleLeads.length,
        duplicatesRemoved: Math.max(0, result.leads.length - visibleLeads.length),
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
  const searchId = `ai-stateless-${randomUUID()}`;
  let location: NormalizedUsLocation;

  try {
    location = await normalizeUsLocation(request.city);
  } catch (error) {
    return buildResponse({
      searchId,
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
    request,
    locationLabel: location.label,
    result: {
      ...result,
      warnings: [...location.warnings, ...result.warnings],
    },
  });
};
