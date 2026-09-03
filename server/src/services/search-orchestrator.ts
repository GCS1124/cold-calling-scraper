import { randomUUID } from 'node:crypto';

import type { Lead } from '../types/lead';
import type {
  ProviderWarning,
  SearchProgress,
  SearchRequest,
  SearchResponse,
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
  discoverUsLeadsFromLinkedinSearch,
  type LinkedInDiscoveryResult,
} from './linkedin-search';
import { enrichLinkedinLeadsWithPublicContacts } from './linkedin-contact-enrichment';
import {
  discoverUsLeadsFromAiMode,
  type AiDiscoveryResult,
} from './ai-lead-discovery';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { resolveCategoryProfile } from './us-category-mapping';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';
import { filterLeadsForLocation } from './location-acceptance';
import { enforcePhoneRequirement } from './phone-requirement';
import { buildDiscoverySeeds } from './discovery-seeds';
import {
  leadSourceModeLabels,
  normalizeLeadSourceMode,
  type LeadSourceMode,
} from './search-source-mode';

type SearchJob = {
  searchId: string;
  request: SearchRequest;
  leads: Lead[];
  locationLabel: string;
  query: string;
  status: SearchStatus;
  progress: SearchProgress;
  providerWarnings: ProviderWarning[];
  expiresAt: number;
  lastProgressAt: number;
  googleMapsUnavailable?: boolean;
};

type SearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
};

type SearchDeps = {
  normalizeLocation?: (rawLocation: string) => Promise<NormalizedUsLocation>;
  enrichLead?: (lead: Lead) => Lead | Promise<Lead>;
  enrichLinkedinLeads?: typeof enrichLinkedinLeadsWithPublicContacts;
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
  discoverLinkedinLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    deadlineMs?: number;
  }) => Promise<LinkedInDiscoveryResult>;
  discoverAiLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    deadlineMs?: number;
  }) => Promise<AiDiscoveryResult>;
  discoverOsmLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    profile: ReturnType<typeof resolveCategoryProfile>;
  }) => Promise<Lead[]>;
  schedule?: (task: () => Promise<void>) => void;
  now?: () => number;
  idFactory?: () => string;
};

const jobTtlMs = 15 * 60 * 1000;
const googleDiscoveryTimeoutMs = 20000;
// Maps is a fallback after Places and OSM. Keep a failed browser attempt from
// holding every regional pass open for the full discovery window.
const googleMapsDiscoveryTimeoutMs = 8_000;
const linkedinDiscoveryTimeoutMs = 90000;
const linkedinProfileDiscoveryWindowMs = 30000;
const linkedinContactEnrichmentWindowMs = 55000;
const aiDiscoveryTimeoutMs = 40000;
const osmDiscoveryTimeoutMs = 20000;
const maxCandidatePool = 3000;
const getDiscoveryStallMs = (requestedCount: number) =>
  requestedCount >= 50 ? 45_000 : 20_000;
const getDiscoveryStallLabel = (requestedCount: number) =>
  requestedCount >= 50 ? '45 seconds' : '20 seconds';

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
  totalCandidates: 0,
  requestedCount,
  foundCount: 0,
  duplicatesRemoved: 0,
  currentSource: 'Queued',
  batchesCompleted: 0,
  estimatedRemaining: requestedCount,
});

const toResponse = (job: SearchJob): SearchResponse => ({
  searchId: job.searchId,
  leads: job.leads,
  meta: {
    query: job.query,
    locationLabel: job.locationLabel,
    status: job.status,
    progress: job.progress,
    totals: computeTotals(job.leads),
    providerWarnings: job.providerWarnings,
  },
});

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
  job.progress.foundCount = job.leads.length;
  job.progress.publicContactsFound = job.leads.filter(
    (lead) => lead.hasEmail || lead.hasPhone,
  ).length;
  job.progress.estimatedRemaining = Math.max(0, job.request.count - job.leads.length);
};

const trimCandidatePool = (leads: Lead[], requestedCount: number) =>
  rankDiscoveryCandidates(leads).slice(0, Math.min(maxCandidatePool, requestedCount * 5));

const finalizeLeads = (job: SearchJob) => {
  const phoneRequirement = enforcePhoneRequirement(job.leads, job.request);
  if (phoneRequirement.warning) {
    appendUniqueWarnings(job, [phoneRequirement.warning]);
  }
  job.leads = rankDiscoveryCandidates(phoneRequirement.leads).slice(0, job.request.count);
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

const runLinkedinDiscovery = async (
  job: SearchJob,
  request: SearchRequest,
  location: NormalizedUsLocation,
  discoverLinkedinLeads: NonNullable<SearchDeps['discoverLinkedinLeads']>,
  enrichLinkedinLeads: SearchDeps['enrichLinkedinLeads'],
  now: () => number,
) => {
  job.progress.currentSource = leadSourceModeLabels.linkedin;

  let linkedinResult: LinkedInDiscoveryResult;
  try {
    linkedinResult = await withTimeout(
      discoverLinkedinLeads({
        request,
        location,
        deadlineMs: Date.now() + linkedinProfileDiscoveryWindowMs,
      }),
      linkedinDiscoveryTimeoutMs,
      'LinkedIn discovery timed out before the batch completed',
    );
  } catch (error) {
    if (error instanceof Error && /timed out/i.test(error.message)) {
      appendUniqueWarnings(job, [
        {
          providerId: 'linkedin-search',
          providerName: 'LinkedIn',
          message: error.message,
        },
      ]);
      return;
    }

    throw error;
  }

  appendUniqueWarnings(job, linkedinResult.warnings);

  if (linkedinResult.coverage) {
    job.progress.publicQueriesAttempted = linkedinResult.coverage.queriesAttempted;
    job.progress.publicProvidersChecked = linkedinResult.coverage.providersChecked;
    job.progress.publicQueryFamilies = linkedinResult.coverage.queryFamilies;
  }

  if (!linkedinResult.leads.length) {
    if (linkedinResult.blocked) {
      appendUniqueWarnings(job, [
        {
          providerId: 'linkedin-search',
          providerName: 'LinkedIn',
          message:
            'LinkedIn search providers were blocked or rate-limited, so no public profiles were returned.',
        },
      ]);
    }

    return;
  }

  upsertLeads(job, linkedinResult.leads, now);

  if (enrichLinkedinLeads) {
    job.status = 'enriching';
    job.progress.discovered = linkedinResult.leads.length;
    job.progress.totalCandidates = linkedinResult.leads.length;

    try {
      const contactResult = await withTimeout(
        enrichLinkedinLeads({
          leads: linkedinResult.leads,
          request,
          location,
          deadlineMs: Date.now() + linkedinContactEnrichmentWindowMs,
          onProgress: (completed) => {
            job.progress.enriched = completed;
          },
        }),
        linkedinContactEnrichmentWindowMs,
        'LinkedIn contact enrichment timed out before the batch completed',
      );

      appendUniqueWarnings(job, contactResult.warnings);
      job.progress.enriched = contactResult.enrichedCount;
      upsertLeads(job, contactResult.leads, now, false);
    } catch (error) {
      appendUniqueWarnings(job, [
        {
          providerId: 'linkedin-public-contact-enrichment',
          providerName: 'Public Contact Search',
          message:
            error instanceof Error
              ? `${error.message}. Discovered public profiles were kept; contact fields may be incomplete.`
              : 'Public contact enrichment failed. Discovered public profiles were kept; contact fields may be incomplete.',
        },
      ]);
    }
  }

  job.progress.batchesCompleted += 1;
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
    job.progress.providerCoverage = result.coverage;
    job.progress.aiAssistance = result.aiAssistance;
    job.progress.enriched = result.enrichedCount;
    if (result.publicCoverage) {
      job.progress.publicQueriesAttempted = result.publicCoverage.queriesAttempted;
      job.progress.publicProvidersChecked = result.publicCoverage.providersChecked;
    }
    upsertLeads(job, result.leads, now);
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
  now: () => number,
) => {
  job.progress.currentSource =
    discoveryLocation.mode === 'nationwide' ? 'Nationwide Discovery' : 'Google Places API';
  const queryVariants = buildDiscoveryQueryVariants(
    request.companyType,
    discoveryLocation,
    profile,
  );
  const googlePlacesAvailable =
    discoverGoogleLeads !== googlePlacesProvider || isGooglePlacesConfigured();

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
                request,
                location: discoveryLocation,
                queryVariants,
                deadlineMs: Date.now() + googleDiscoveryTimeoutMs,
              })
            : discoverGoogleLeads.fetchLeads({
                rawQuery: request.companyType,
                query: `${request.companyType} in ${discoveryLocation.label}`,
                queryVariants,
                request: {
                  ...request,
                  city: discoveryLocation.label,
                  count: Math.max(request.count, 100),
                },
                location: discoveryLocation,
                deadlineMs: Date.now() + googleDiscoveryTimeoutMs,
              }),
          googleDiscoveryTimeoutMs,
          'Google Places discovery timed out before the batch completed',
        );
        const acceptedGoogleLeads = filterLeadsForLocation(googleLeads, targetLocation);
        upsertLeads(job, acceptedGoogleLeads, now);
        job.progress.batchesCompleted += 1;
      } catch (error) {
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
            request,
            location: discoveryLocation,
            profile,
          }),
          osmDiscoveryTimeoutMs,
          'OpenStreetMap discovery timed out before the batch completed',
        );
        const acceptedOsmLeads = filterLeadsForLocation(osmLeads, targetLocation);
        upsertLeads(job, acceptedOsmLeads, now);
        job.progress.batchesCompleted += 1;
      } catch (error) {
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

  if (job.progress.foundCount < request.count && discoverGoogleMapsLeads) {
    try {
      const remainingCount = request.count - job.progress.foundCount;
      const googleMapsLeads = await withTimeout(
        discoverGoogleMapsLeads({
          request: {
          ...request,
          count: Math.min(Math.max(remainingCount, 15), 30),
        },
        location: discoveryLocation,
        queryVariants,
        maxResults: Math.min(Math.max(remainingCount, 15), 30),
        queryLimit: 12,
        deadlineMs: Date.now() + googleMapsDiscoveryTimeoutMs,
      }),
        googleMapsDiscoveryTimeoutMs,
        'Google Maps discovery timed out before the batch completed',
      );
      const acceptedGoogleMapsLeads = filterLeadsForLocation(googleMapsLeads, targetLocation);
      upsertLeads(job, acceptedGoogleMapsLeads, now);
      job.progress.batchesCompleted += 1;
      job.progress.currentSource = 'Google Maps API';
    } catch (error) {
      googleMapsUnavailable = true;
      appendUniqueWarnings(job, [{
        providerId: 'google-maps',
        providerName: 'Google Maps',
        message: formatGoogleMapsFailure(error),
      }]);
    }
  }

  return {
    googleMapsUnavailable,
  };
};

export const createSearchService = (deps: SearchDeps = {}): SearchService => {
  const jobs = new Map<string, SearchJob>();
  const normalizeLocation = deps.normalizeLocation ?? normalizeUsLocation;
  const discoverGoogleLeads = deps.discoverGoogleLeads ?? googlePlacesProvider;
  const discoverGoogleMapsLeads =
    deps.discoverGoogleMapsLeads ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromGoogleMaps);
  const discoverLinkedinLeads =
    deps.discoverLinkedinLeads ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromLinkedinSearch);
  const discoverAiLeads = deps.discoverAiLeads ?? discoverUsLeadsFromAiMode;
  const enrichLinkedinLeads =
    deps.enrichLinkedinLeads ??
    (deps.discoverLinkedinLeads ? undefined : enrichLinkedinLeadsWithPublicContacts);
  const discoverOsmLeads = deps.discoverOsmLeads ?? discoverUsLeadsFromOsm;
  const now = deps.now ?? Date.now;
  const idFactory = deps.idFactory ?? randomUUID;
  const schedule =
    deps.schedule ??
    ((task: () => Promise<void>) => {
      setTimeout(() => {
        void task();
      }, 0);
    });

  const markFailed = (job: SearchJob, warning: ProviderWarning) => {
    job.status = 'failed';
    job.providerWarnings.push(warning);
    refreshProgress(job);
  };

  const processJob = async (job: SearchJob) => {
    job.status = 'discovering';
    job.progress.currentSource = 'Nominatim';
    const sourceMode: LeadSourceMode = normalizeLeadSourceMode(job.request.sourceMode);
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
      markFailed(job, {
        providerId: 'nominatim',
        providerName: 'Nominatim',
        message:
          error instanceof Error ? error.message : 'US location normalization failed',
      });
      return;
    }

    job.progress.currentSource = leadSourceModeLabels[sourceMode];

    if (sourceMode === 'linkedin') {
      if (!discoverLinkedinLeads) {
        markFailed(job, {
          providerId: 'linkedin-search',
          providerName: 'LinkedIn',
          message: 'LinkedIn discovery is not configured for this environment.',
        });
        return;
      }

      try {
        await runLinkedinDiscovery(
          job,
          job.request,
          location,
          discoverLinkedinLeads,
          enrichLinkedinLeads,
          now,
        );
      } catch (error) {
        markFailed(job, {
          providerId: 'linkedin-search',
          providerName: 'LinkedIn',
          message:
            error instanceof Error
              ? error.message
              : 'LinkedIn discovery failed',
        });
        return;
      }

      finalizeLeads(job);
      refreshProgress(job);
      job.status = 'complete';
      job.progress.currentSource = 'Complete';
      refreshProgress(job);
      return;
    }

    if (sourceMode === 'ai') {
      await runAiDiscovery(job, job.request, location, discoverAiLeads, now);
      finalizeLeads(job);
      refreshProgress(job);
      job.status = 'complete';
      job.progress.currentSource = 'Complete';
      refreshProgress(job);
      return;
    }

    const profile = resolveCategoryProfile(job.request.companyType);
    job.providerWarnings.push(...profile.warnings);

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
      if (job.progress.foundCount >= job.request.count) {
        break;
      }

      if (
        job.progress.foundCount < job.request.count &&
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

      const foundCountBeforeRegional = job.progress.foundCount;
      const regionalResult = await runRegionalDiscovery(
        job,
        job.request,
        location,
        regionalLocation,
        profile,
        discoverGoogleLeads,
        guardedDiscoverGoogleMapsLeads,
        discoverOsmLeads,
        now,
      );

      if (regionalResult.googleMapsUnavailable) {
        job.googleMapsUnavailable = true;
      }

      if (
        job.googleMapsUnavailable &&
        job.progress.foundCount === foundCountBeforeRegional
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
        job.progress.foundCount < job.request.count &&
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

    finalizeLeads(job);
    job.status = 'complete';
    job.progress.currentSource = 'Complete';
    refreshProgress(job);
  };

  return {
    async startSearch(request) {
      const startedAt = now();
      cleanupExpiredJobs(jobs, () => startedAt);

      const searchId = idFactory();
      const job: SearchJob = {
        searchId,
        request,
        leads: [],
        locationLabel: request.city.trim(),
        query: `${request.companyType} in ${request.city.trim()}`,
        status: 'queued',
        progress: createProgress(request.count),
        providerWarnings: [],
        expiresAt: startedAt + jobTtlMs,
        lastProgressAt: startedAt,
      };

      jobs.set(searchId, job);
      schedule(async () => {
        await processJob(job);
      });

      return toResponse(job);
    },

    async getSearch(searchId) {
      cleanupExpiredJobs(jobs, now);
      const job = jobs.get(searchId);
      return job ? toResponse(job) : null;
    },
  };
};

export const searchService = createSearchService();
