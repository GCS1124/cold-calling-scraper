import { randomUUID } from 'node:crypto';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchProgress, SearchRequest, SearchResponse, SearchStatus } from '../types/search';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead } from './lead-validation';
import { discoverUsLeadsFromOsm } from './osm-discovery';
import {
  discoverUsLeadsFromLinkedinSearch,
  type LinkedInDiscoveryResult,
} from './linkedin-search';
import { enrichLinkedinLeadsWithPublicContacts } from './linkedin-contact-enrichment';
import { googlePlacesProvider } from '../providers/google-places';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';
import { filterLeadsForLocation } from './location-acceptance';
import {
  createSearchJobStore,
  CURRENT_SCHEMA_VERSION,
  type SearchJobRecord,
  toSearchResponse,
} from './search-job-store';
import { resolveCategoryProfile } from './us-category-mapping';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { buildDiscoverySeeds } from './discovery-seeds';
import {
  leadSourceModeLabels,
  normalizeLeadSourceMode,
  type LeadSourceMode,
} from './search-source-mode';

type VercelSearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
  getSearchSnapshot: (searchId: string) => Promise<SearchResponse | null>;
  advanceSearch: (searchId: string) => Promise<SearchResponse | null>;
};

type VercelSearchServiceDeps = {
  store?: ReturnType<typeof createSearchJobStore>;
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
    deadlineMs?: number;
  }) => Promise<LinkedInDiscoveryResult>;
  enrichLinkedinLeads?: typeof enrichLinkedinLeadsWithPublicContacts;
  discoverOsmLeads?: (args: {
    request: { companyType: string; count: number };
    location: NormalizedUsLocation;
    profile: ReturnType<typeof resolveCategoryProfile>;
    deadlineMs?: number;
  }) => Promise<Lead[]>;
  enrichWebsiteLead?: (lead: Lead) => Promise<unknown>;
  now?: () => number;
  idFactory?: () => string;
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
  requestedCount >= 50 ? 20_000 : 8_000;
const getGoogleMapsTimeoutMs = (requestedCount: number) =>
  requestedCount >= 50 ? 15_000 : 8_000;
const getLinkedinProfileDiscoveryWindowMs = (requestedCount: number) =>
  requestedCount >= 50 ? 30_000 : 20_000;
const getLinkedinContactEnrichmentWindowMs = (requestedCount: number) =>
  requestedCount >= 50 ? 24_000 : 14_000;
const getMaxTickDurationMs = (requestedCount: number) =>
  requestedCount >= 50 ? 45_000 : 30_000;
const processingLeaseMs = 70_000;

const withNow = () => Date.now();

const createProgress = (requestedCount: number): SearchProgress => ({
  discovered: 0,
  enriched: 0,
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
  job.progress.foundCount = job.leads.length;
  job.progress.estimatedRemaining = Math.max(0, job.request.count - job.leads.length);
};

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
  job.leads = rankDiscoveryCandidates(job.leads).slice(0, job.request.count);
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
  now: () => number,
) => {
  job.progress.currentSource = leadSourceModeLabels.linkedin;

  const linkedinResult = await discoverLinkedinLeads({
    request,
    location,
    deadlineMs: now() + getLinkedinProfileDiscoveryWindowMs(request.count),
  });

  for (const warning of linkedinResult.warnings) {
    appendWarningOnce(job, warning);
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

  mergeLeads(job, linkedinResult.leads, now);
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

  const contactResult = await enrichLinkedinLeads({
    leads: job.leads,
    request,
    location,
    deadlineMs: now() + getLinkedinContactEnrichmentWindowMs(request.count),
    onProgress: (completed) => {
      job.progress.enriched = completed;
      job.updatedAt = now();
    },
  });

  for (const warning of contactResult.warnings) {
    appendWarningOnce(job, warning);
  }

  job.progress.enriched = contactResult.enrichedCount;
  mergeLeads(job, contactResult.leads, now, false);
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
  const perSeedCount = getPerSeedCount(request.count);
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
  const googlePlacesDeadlineMs = Math.min(
    deadlineMs,
    now() + getGooglePlacesTimeoutMs(request.count),
  );

  let googleLeads: Lead[] = [];
  try {
    googleLeads = await googlePlaces.fetchLeads({
      rawQuery: request.companyType,
      query,
      queryVariants,
      request: googleRequest,
      location: discoveryLocation,
      deadlineMs: googlePlacesDeadlineMs,
    });
  } catch (error) {
    warnings.push({
      providerId: 'google-places',
      providerName: 'Google Places',
      message:
        error instanceof Error
          ? error.message
          : 'Google Places discovery failed',
    });
  }

  let osmLeads: Lead[] = [];
  try {
    if (!googleLeads.length) {
      osmLeads = await discoverOsmLeads({
        request: googleRequest,
        location: discoveryLocation,
        profile,
        deadlineMs,
      });
    }
  } catch (error) {
    warnings.push({
      providerId: 'osm-discovery',
      providerName: 'OpenStreetMap',
      message:
        error instanceof Error ? error.message : 'OpenStreetMap discovery failed',
    });
  }

  if (!googleLeads.length && !osmLeads.length) {
    warnings.push({
      providerId: 'discovery',
      providerName: 'Discovery',
      message: `No discovery candidates returned for ${discoveryLocation.label}`,
    });
  }

  const acceptedDiscoveryLeads = filterLeadsForLocation([...googleLeads, ...osmLeads], targetLocation);
  let googleMapsLeads: Lead[] = [];

  if (acceptedDiscoveryLeads.length < request.count && discoverGoogleMapsLeads) {
    try {
      const remainingCount = request.count - acceptedDiscoveryLeads.length;
      const googleMapsRequestCount = Math.min(Math.max(remainingCount, 15), 30);
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
        queryLimit: 12,
        deadlineMs: googleMapsDeadlineMs,
      });
    } catch (error) {
      warnings.push({
        providerId: 'google-maps',
        providerName: 'Google Maps',
        message:
          error instanceof Error ? error.message : 'Google Maps discovery failed',
      });
    }
  }

  return {
    leads: filterLeadsForLocation([...acceptedDiscoveryLeads, ...googleMapsLeads], targetLocation),
    warnings,
  };
};

const tickJob = async (
  job: SearchJobRecord,
  store: ReturnType<typeof createSearchJobStore>,
  deps: Required<Pick<VercelSearchServiceDeps, 'googlePlaces' | 'normalizeLocation' | 'discoverOsmLeads' | 'now'>> &
    Pick<
      VercelSearchServiceDeps,
      'discoverGoogleMapsLeads' | 'discoverLinkedinLeads' | 'enrichLinkedinLeads'
    >,
): Promise<SearchJobRecord> => {
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
        await runLinkedinEnrichment(
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
          deps.now,
        );

        if (deps.enrichLinkedinLeads && job.leads.length) {
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
    job.discoveryComplete = true;
    finalizeLeads(job);
    job.status = 'complete';
    job.progress.currentSource = 'Complete';
    refreshProgress(job);
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

      const { leads, warnings } = await discoverRegionLeads(
        job.request,
        targetLocation,
        regionalLocation,
        deps.googlePlaces,
        deps.discoverGoogleMapsLeads,
        deps.discoverOsmLeads,
        deps.now,
        resolveCategoryProfile(job.request.companyType),
        deps.now() + maxTickDurationMs,
      );

      job.providerWarnings.push(...warnings);
      mergeLeads(job, leads, deps.now);
      job.nextSeedIndex += 1;
      job.progress.batchesCompleted += 1;
      processed += 1;
      job.expiresAt = withNow() + jobTtlMs;

      if (job.progress.foundCount >= job.request.count) {
        break;
      }
    }
  }

  job.discoveryComplete = job.nextSeedIndex >= job.searchSeeds.length;
  const stalledForTooLong =
    job.progress.foundCount < job.request.count &&
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

  if (job.progress.foundCount >= job.request.count || job.discoveryComplete) {
    finalizeLeads(job);
    job.status = 'complete';
    job.progress.currentSource = 'Complete';
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
  const inFlightTicks = new Map<string, Promise<SearchJobRecord>>();
  const googlePlaces = deps.googlePlaces ?? googlePlacesProvider;
  const normalizeLocation = deps.normalizeLocation ?? normalizeUsLocation;
  const discoverGoogleMapsLeads =
    deps.discoverGoogleMapsLeads ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverGoogleMapsLeadsOnDemand);
  const discoverLinkedinLeads =
    deps.discoverLinkedinLeads ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromLinkedinSearch);
  const enrichLinkedinLeads =
    deps.enrichLinkedinLeads ??
    (deps.discoverLinkedinLeads ? undefined : enrichLinkedinLeadsWithPublicContacts);
  const discoverOsm = deps.discoverOsmLeads ?? discoverUsLeadsFromOsm;
  const now = deps.now ?? withNow;
  const idFactory = deps.idFactory ?? randomUUID;

  const getStoredSearch = async (searchId: string) => {
    await store.ensureSchema();

    const job = await store.get(searchId);
    return job ? toSearchResponse(job) : null;
  };

  const advanceSearch = async (searchId: string) => {
    await store.ensureSchema();

    const job = await store.get(searchId);
    if (!job) {
      return null;
    }

    // Keep one provider tick per warm function instance. The durable snapshot
    // remains the source of truth when another request overlaps this work.
    const existingTick = inFlightTicks.get(searchId);
    if (existingTick) {
      return toSearchResponse(job);
    }

    const processingToken = randomUUID();
    const claimedJob = await store.claim(
      searchId,
      now(),
      processingLeaseMs,
      processingToken,
    );

    if (!claimedJob) {
      const latestJob = await store.get(searchId);
      return latestJob ? toSearchResponse(latestJob) : null;
    }

    const tick = tickJob(claimedJob, store, {
      googlePlaces,
      normalizeLocation,
      discoverGoogleMapsLeads,
      discoverLinkedinLeads,
      enrichLinkedinLeads,
      discoverOsmLeads: discoverOsm,
      now,
    });
    inFlightTicks.set(searchId, tick);

    try {
      return toSearchResponse(await tick);
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
    async startSearch(request) {
      await store.ensureSchema();
      await store.deleteExpired(now());

      const searchId = idFactory();
      const createdAt = now();
      let job: SearchJobRecord = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        searchId,
        request,
        query: `${request.companyType} in ${request.city}`,
        locationLabel: request.city,
        locationMode: 'local',
        status: 'queued',
        progress: createProgress(request.count),
        leads: [],
        providerWarnings: [],
        searchSeeds: [],
        nextSeedIndex: 0,
        discoveryComplete: false,
        lastProgressAt: createdAt,
        expiresAt: createdAt + jobTtlMs,
        createdAt,
        updatedAt: createdAt,
      };

      await store.upsert(job);

      return toSearchResponse(job);
    },

    async getSearch(searchId) {
      return advanceSearch(searchId);
    },

    getSearchSnapshot: getStoredSearch,
    advanceSearch,
  };
};

export const vercelSearchService = createVercelSearchService();
