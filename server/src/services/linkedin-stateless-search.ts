import { randomUUID } from 'node:crypto';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest, SearchResponse } from '../types/search';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead } from './lead-validation';
import {
  discoverUsLeadsFromLinkedinSearch,
  type LinkedInDiscoveryResult,
} from './linkedin-search';
import { enrichLinkedinLeadsWithPublicContacts } from './linkedin-contact-enrichment';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';

// Keep the no-database path within the Vercel function budget. It returns a
// completed public-only response, so the client does not need a durable poll.
const discoveryWindowMs = 25_000;
const contactEnrichmentWindowMs = 12_000;

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
  request,
  locationLabel,
  leads,
  discovered,
  enriched,
  warnings,
  coverage,
}: {
  searchId: string;
  request: SearchRequest;
  locationLabel: string;
  leads: Lead[];
  discovered: number;
  enriched: number;
  warnings: ProviderWarning[];
  coverage?: LinkedInDiscoveryResult['coverage'];
}): SearchResponse => {
  const visibleLeads = deduplicateLeads(leads).slice(0, request.count);

  return {
    searchId,
    leads: visibleLeads,
    meta: {
      query: `${request.companyType} in ${locationLabel}`,
      locationLabel,
      status: 'complete',
      progress: {
        discovered,
        enriched,
        publicContactsFound: visibleLeads.filter(
          (lead) => lead.hasEmail || lead.hasPhone,
        ).length,
        publicQueriesAttempted: coverage?.queriesAttempted,
        publicProvidersChecked: coverage?.providersChecked,
        totalCandidates: visibleLeads.length,
        requestedCount: request.count,
        foundCount: visibleLeads.length,
        duplicatesRemoved: Math.max(0, leads.length - visibleLeads.length),
        currentSource: 'Complete',
        batchesCompleted: 1,
        estimatedRemaining: Math.max(0, request.count - visibleLeads.length),
      },
      totals: {
        total: visibleLeads.length,
        withEmail: visibleLeads.filter((lead) => lead.hasEmail).length,
        withPhone: visibleLeads.filter((lead) => lead.hasPhone).length,
        withWebsite: visibleLeads.filter((lead) => lead.hasWebsite).length,
      },
      providerWarnings: warnings,
    },
  };
};

const buildLocationFailureResponse = (
  searchId: string,
  request: SearchRequest,
  error: unknown,
) =>
  buildResponse({
    searchId,
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

export const runStatelessLinkedinSearch = async (
  request: SearchRequest,
): Promise<SearchResponse> => {
  const searchId = `linkedin-stateless-${randomUUID()}`;
  let location: NormalizedUsLocation;

  try {
    location = await normalizeUsLocation(request.city);
  } catch (error) {
    return buildLocationFailureResponse(searchId, request, error);
  }

  const warnings: ProviderWarning[] = [];
  addWarnings(warnings, location.warnings);

  let discoveryResult: LinkedInDiscoveryResult = {
    leads: [],
    warnings: [],
    blocked: false,
  };

  try {
    discoveryResult = await discoverUsLeadsFromLinkedinSearch({
      request,
      location,
      deadlineMs: Date.now() + discoveryWindowMs,
    });
    addWarnings(warnings, discoveryResult.warnings);
  } catch (error) {
    addWarnings(warnings, [buildDiscoveryFailureWarning(error)]);
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
    try {
      const contactResult = await enrichLinkedinLeadsWithPublicContacts({
        leads,
        request,
        location,
        deadlineMs: Date.now() + contactEnrichmentWindowMs,
      });
      addWarnings(warnings, contactResult.warnings);
      leads = deduplicateLeads(contactResult.leads.map(enrichLead));
      enriched = contactResult.enrichedCount;
    } catch (error) {
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
  }

  return buildResponse({
    searchId,
    request,
    locationLabel: location.label,
    leads,
    discovered,
    enriched,
    warnings,
    coverage: discoveryResult.coverage,
  });
};
