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
import { normalizeUsLocation } from './us-location';
import { freeAiModePolicy, salesProviderAudits } from '../providers/sales-intelligence';
import {
  expandQueryWithGemini,
  isGeminiQueryAssistanceEnabled,
} from '../providers/gemini';
import { enforcePhoneRequirement } from './phone-requirement';

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
    let queryHints: string[] = [];

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
          queryHints = [normalizedAssistedQuery];
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
    let discoveryResult: LinkedInDiscoveryResult = {
      leads: [],
      warnings: [],
      blocked: false,
    };

    try {
      discoveryResult = await withTimeout(
        discoverLinkedin({
          request,
          location,
          queryHints,
          deadlineMs: Math.min(deadlineMs, Date.now() + discoveryWindowMs),
        }),
        deadlineMs,
        'Free public discovery timed out before the batch completed.',
      );
      for (const warning of discoveryResult.warnings) {
        addWarning(warnings, warning);
      }
      updateCoverage(coverage, 'linkedin-public-search', {
        status: discoveryResult.blocked ? 'failed' : 'returned',
        leadCount: discoveryResult.leads.length,
        message: discoveryResult.blocked
          ? 'Public search providers were blocked or rate-limited; no unverified profiles were added.'
          : 'Public LinkedIn profile results were matched and deduplicated.',
      });
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
    }

    let leads = deduplicateLeads(discoveryResult.leads.map(enrichLead));
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

export const discoverUsLeadsFromAiMode = createAiLeadDiscovery();

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

  return {
    searchId,
    leads: visibleLeads,
    meta: {
      query: `${request.companyType} in ${locationLabel}`,
      locationLabel,
      status: 'complete',
      progress: {
        discovered: visibleLeads.length,
        enriched: result.enrichedCount,
        publicContactsFound: visibleLeads.filter((lead) => lead.hasEmail || lead.hasPhone).length,
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
