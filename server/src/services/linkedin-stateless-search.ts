import { randomUUID } from 'node:crypto';

import type { Lead } from '../types/lead';
import type {
  ProviderCoverage,
  ProviderWarning,
  SearchRequest,
  SearchResponse,
} from '../types/search';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead } from './lead-validation';
import {
  discoverUsLeadsFromLinkedinSearch,
  type LinkedInDiscoveryResult,
} from './linkedin-search';
import { enrichLinkedinLeadsWithPublicContacts } from './linkedin-contact-enrichment';
import { discoverUsLeadsFromOsm } from './osm-discovery';
import { bridgeLinkedInWithPublicListings } from './public-entity-matching';
import { enforcePhoneRequirement } from './phone-requirement';
import { noUsableResultsWarning } from './search-finalization';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';
import { resolveCategoryProfile } from './us-category-mapping';
import { getLeadDiscoveryCandidateTarget } from './lead-discovery-budget';
import {
  buildSearchExecutionContract,
  buildSearchResponseContract,
} from '../../../shared/search-contract';
import { normalizeLeadSourceMode } from './search-source-mode';
import { mergeProviderCoverage } from './provider-coverage';

// Keep the no-database path within the Vercel function budget. It returns a
// completed public-only response, so the client does not need a durable poll.
const discoveryWindowMs = 25_000;
const contactEnrichmentWindowMs = 18_000;

type StatelessLinkedInSearchDeps = {
  discoverLinkedin?: typeof discoverUsLeadsFromLinkedinSearch;
  discoverPublicListings?: typeof discoverUsLeadsFromOsm;
  enrichPublicContacts?: typeof enrichLinkedinLeadsWithPublicContacts;
  normalizeLocation?: typeof normalizeUsLocation;
};

const addWarnings = (target: ProviderWarning[], incoming: ProviderWarning[]) => {
  for (const warning of incoming) {
    if (
      target.some(
        (existing) =>
          existing.providerId === warning.providerId && existing.message === warning.message,
      )
    ) {
      continue;
    }

    target.push(warning);
  }
};

const buildResponse = ({
  searchId,
  startedAt,
  request,
  locationLabel,
  leads,
  discovered,
  enriched,
  warnings,
  coverage,
  providerCoverage,
}: {
  searchId: string;
  startedAt: string;
  request: SearchRequest;
  locationLabel: string;
  leads: Lead[];
  discovered: number;
  enriched: number;
  warnings: ProviderWarning[];
  coverage?: LinkedInDiscoveryResult['coverage'];
  providerCoverage?: ProviderCoverage[];
}): SearchResponse => {
  const deduplicatedLeads = deduplicateLeads(leads);
  const phoneRequirement = enforcePhoneRequirement(deduplicatedLeads, request);
  const responseWarnings = [...warnings];
  if (phoneRequirement.warning) {
    addWarnings(responseWarnings, [phoneRequirement.warning]);
  }
  const visibleLeads = phoneRequirement.leads.slice(0, request.count);
  const status = visibleLeads.length ? 'complete' : 'failed';
  if (!visibleLeads.length) {
    addWarnings(responseWarnings, [noUsableResultsWarning()]);
  }

  const contract = buildSearchResponseContract(normalizeLeadSourceMode(request.sourceMode ?? 'linkedin'));
  const completedAt = new Date().toISOString();

  return {
    ...contract,
    searchId,
    leads: visibleLeads,
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
      progress: {
        discovered,
        enriched,
        publicContactsFound: visibleLeads.filter(
          (lead) => lead.hasEmail || lead.hasPhone,
        ).length,
        phoneExcludedCount: phoneRequirement.excludedCount,
        publicQueriesAttempted: coverage?.queriesAttempted,
        publicProvidersChecked: coverage?.providersChecked,
        publicQueryFamilies: coverage?.queryFamilies,
        publicQueryFamilyCounts: coverage?.queryFamilyCounts,
        providerCoverage,
        totalCandidates: deduplicatedLeads.length,
        requestedCount: request.count,
        foundCount: visibleLeads.length,
        duplicatesRemoved: Math.max(0, leads.length - deduplicatedLeads.length),
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

const buildLocationFailureResponse = (
  searchId: string,
  startedAt: string,
  request: SearchRequest,
  error: unknown,
) =>
  buildResponse({
    searchId,
    startedAt,
    request,
    locationLabel: request.city,
    leads: [],
    discovered: 0,
    enriched: 0,
    warnings: [
      {
        providerId: 'location-normalizer',
        providerName: 'Location Normalizer',
        message:
          error instanceof Error ? error.message : 'US location normalization failed.',
      },
    ],
  });

const buildDiscoveryFailureWarning = (error: unknown): ProviderWarning => ({
  providerId: 'linkedin-search',
  providerName: 'LinkedIn',
  message:
    error instanceof Error
      ? `${error.message}. Public profiles returned before the failure were preserved.`
      : 'Public LinkedIn discovery failed. No unverified leads were added.',
});

export const createStatelessLinkedinSearch = (
  deps: StatelessLinkedInSearchDeps = {},
) => {
  const discoverLinkedin = deps.discoverLinkedin ?? discoverUsLeadsFromLinkedinSearch;
  const discoverPublicListings =
    deps.discoverPublicListings ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromOsm);
  const enrichPublicContacts =
    deps.enrichPublicContacts ?? enrichLinkedinLeadsWithPublicContacts;
  const normalizeLocation = deps.normalizeLocation ?? normalizeUsLocation;

  return async (request: SearchRequest): Promise<SearchResponse> => {
    const startedAt = new Date().toISOString();
    const searchId = `linkedin-stateless-${randomUUID()}`;
    let location: NormalizedUsLocation;

    try {
      location = await normalizeLocation(request.city);
    } catch (error) {
      return buildLocationFailureResponse(searchId, startedAt, request, error);
    }

    const warnings: ProviderWarning[] = [];
    addWarnings(warnings, location.warnings);

    let providerCoverage: ProviderCoverage[] = [
      {
        providerId: 'linkedin-public-search',
        providerName: 'Public LinkedIn Search',
        status: 'configured',
        leadCount: 0,
        message:
          'Public search engines only; private profiles and authenticated sessions are not accessed.',
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
    ];
    const addCoverage = (entries: ProviderCoverage[]) => {
      providerCoverage = mergeProviderCoverage(providerCoverage, entries);
    };
    let linkedinFailed = false;
    let publicListingsFailed = false;

    let discoveryResult: LinkedInDiscoveryResult = {
      leads: [],
      warnings: [],
      blocked: false,
    };

    const discoveryDeadlineMs = Date.now() + discoveryWindowMs;
    const [linkedinResult, publicListingLeads] = await Promise.all([
      (async () => {
        try {
          return await discoverLinkedin({
            request,
            location,
            deadlineMs: discoveryDeadlineMs,
          });
        } catch (error) {
          linkedinFailed = true;
          addWarnings(warnings, [buildDiscoveryFailureWarning(error)]);
          return discoveryResult;
        }
      })(),
      (async () => {
        if (!discoverPublicListings) {
          return [] as Lead[];
        }

        try {
          const listings = await discoverPublicListings({
            request: {
              companyType: request.companyType,
              count: getLeadDiscoveryCandidateTarget(request.count, 3),
            },
            location,
            profile: resolveCategoryProfile(request.companyType),
            deadlineMs: discoveryDeadlineMs,
          });

          if (listings.length) {
            addWarnings(warnings, [
              {
                providerId: 'public-business-listings',
                providerName: 'Public Business Listings',
                message:
                  `Checked ${listings.length} free public listings to corroborate LinkedIn organizations and phone evidence.`,
                severity: 'info',
              },
            ]);
          }

          return listings;
        } catch (error) {
          publicListingsFailed = true;
          addWarnings(warnings, [
            {
              providerId: 'public-business-listings',
              providerName: 'Public Business Listings',
              message:
                error instanceof Error
                  ? `${error.message} LinkedIn profiles were preserved.`
                  : 'Public business-listing discovery failed. LinkedIn profiles were preserved.',
              severity: 'warning',
            },
          ]);
          return [] as Lead[];
        }
      })(),
    ]);

    discoveryResult = linkedinResult;
    addWarnings(warnings, discoveryResult.warnings);
    addCoverage([
      {
        providerId: 'linkedin-public-search',
        providerName: 'Public LinkedIn Search',
        status: linkedinFailed || discoveryResult.blocked ? 'failed' : 'returned',
        leadCount: discoveryResult.leads.length,
        message:
          linkedinFailed || discoveryResult.blocked
            ? 'Public search providers failed, were blocked, or were rate-limited.'
            : 'Public LinkedIn profile results were returned and deduplicated.',
      },
      {
        providerId: 'public-business-listings',
        providerName: 'Public Business Listings',
        status: publicListingsFailed
          ? 'failed'
          : discoverPublicListings
            ? 'returned'
            : 'not_configured',
        leadCount: publicListingLeads.length,
        message: publicListingsFailed
          ? 'Public listing discovery failed; LinkedIn profiles were preserved.'
          : `Free public listing provider returned ${publicListingLeads.length} candidate(s).`,
      },
    ]);

    if (publicListingLeads.length && discoveryResult.leads.length) {
      discoveryResult = {
        ...discoveryResult,
        leads: bridgeLinkedInWithPublicListings(
          discoveryResult.leads,
          publicListingLeads,
        ),
      };
    }

    if (!discoveryResult.leads.length && discoveryResult.blocked) {
      addWarnings(warnings, [
        {
          providerId: 'linkedin-search',
          providerName: 'LinkedIn',
          message:
            'LinkedIn search providers were blocked or rate-limited, so no public profiles were returned.',
        },
      ]);
    }

    let leads = deduplicateLeads(discoveryResult.leads.map(enrichLead));
    const discovered = leads.length;
    let enriched = 0;

    if (leads.length) {
      addCoverage([
        {
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          status: 'configured',
          leadCount: 0,
          message:
            'A bounded crawl checks public business pages for published contact details.',
        },
      ]);
      try {
        const contactResult = await enrichPublicContacts({
          leads,
          request,
          location,
          deadlineMs: Date.now() + contactEnrichmentWindowMs,
        });
        addWarnings(warnings, contactResult.warnings);
        addCoverage([
          {
            providerId: 'public-website-enrichment',
            providerName: 'Public Website Enrichment',
            status: 'returned',
            leadCount: contactResult.enrichedCount,
            message:
              'Public business websites were checked for published contact details.',
          },
        ]);
        leads = deduplicateLeads(contactResult.leads.map(enrichLead));
        enriched = contactResult.enrichedCount;
      } catch (error) {
        addCoverage([
          {
            providerId: 'public-website-enrichment',
            providerName: 'Public Website Enrichment',
            status: 'failed',
            leadCount: 0,
            message:
              error instanceof Error
                ? error.message
                : 'Public website enrichment failed.',
          },
        ]);
        addWarnings(warnings, [
          {
            providerId: 'linkedin-public-contact-enrichment',
            providerName: 'Public Contact Search',
            message:
              error instanceof Error
                ? `${error.message}. Public profiles were preserved; contact fields may be incomplete.`
                : 'Public contact enrichment failed. Public profiles were preserved; contact fields may be incomplete.',
          },
        ]);
      }
    } else {
      addCoverage([
        {
          providerId: 'public-website-enrichment',
          providerName: 'Public Website Enrichment',
          status: 'configured',
          leadCount: 0,
          message: 'No public profiles were available for website enrichment.',
        },
      ]);
    }

    return buildResponse({
      searchId,
      startedAt,
      request,
      locationLabel: location.label,
      leads,
      discovered,
      enriched,
      warnings,
      coverage: discoveryResult.coverage,
      providerCoverage,
    });
  };
};

export const runStatelessLinkedinSearch = createStatelessLinkedinSearch();
