import { randomUUID } from 'node:crypto';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchProgress, SearchRequest, SearchResponse, SearchStatus } from '../types/search';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead } from './lead-validation';
import { discoverUsLeadsFromOsm } from './osm-discovery';
import { discoverUsLeadsFromGoogleMaps } from './google-maps-discovery';
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

type VercelSearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
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
  discoverOsmLeads?: typeof discoverUsLeadsFromOsm;
  enrichWebsiteLead?: (lead: Lead) => Promise<unknown>;
  now?: () => number;
  idFactory?: () => string;
};

const jobTtlMs = 15 * 60 * 1000;
const maxCandidatePool = 3000;
const googleMapsDiscoveryTimeoutMs = 9000;
const getDiscoveryStallMs = (requestedCount: number) =>
  requestedCount >= 50 ? 45_000 : 20_000;
const getDiscoveryStallLabel = (requestedCount: number) =>
  requestedCount >= 50 ? '45 seconds' : '20 seconds';

const getDiscoveryBatchSize = (requestedCount: number) => (requestedCount >= 100 ? 2 : 1);
const getPerSeedCount = (requestedCount: number) =>
  requestedCount >= 100 ? 30 : requestedCount >= 50 ? 25 : 20;
const getMaxTickDurationMs = (requestedCount: number) => (requestedCount >= 100 ? 7_000 : 5_000);

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
      Number(left.hasWebsite) * 5 +
      Number(left.hasPhone) * 5 +
      Number(Boolean(left.address)) * 2 +
      Number(Boolean(left.website && left.mobile)) * 4 +
      (left.sourceScore ?? 0) / 20;
    const rightSignal =
      Number(right.source.includes('Google Places')) * 8 +
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

const mergeLeads = (job: SearchJobRecord, incoming: Lead[], now: () => number) => {
  const previousCount = job.leads.length;
  const merged = [...job.leads, ...incoming.map(normalizeLead)];
  const { leads, duplicatesRemoved } = dedupeWithCount(merged);
  job.progress.duplicatesRemoved += duplicatesRemoved;
  job.leads = trimCandidatePool(leads, job.request.count);
  if (job.leads.length > previousCount) {
    job.lastProgressAt = now();
  }
  refreshProgress(job);
};

const buildQuery = (companyType: string, location: NormalizedUsLocation) =>
  `${companyType} in ${location.label}`;

const discoverRegionLeads = async (
  request: SearchRequest,
  targetLocation: NormalizedUsLocation,
  discoveryLocation: NormalizedUsLocation,
  googlePlaces: typeof googlePlacesProvider,
  discoverGoogleMapsLeads: VercelSearchServiceDeps['discoverGoogleMapsLeads'],
  discoverOsmLeads: typeof discoverUsLeadsFromOsm,
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

  let googleLeads: Lead[] = [];
  try {
    googleLeads = await googlePlaces.fetchLeads({
      rawQuery: request.companyType,
      query,
      queryVariants,
      request: googleRequest,
      location: discoveryLocation,
      deadlineMs,
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

  if (
    acceptedDiscoveryLeads.length < request.count &&
    discoveryLocation.mode === 'local' &&
    discoveryLocation.label.includes(',') &&
    discoverGoogleMapsLeads
  ) {
    try {
      const remainingCount = request.count - acceptedDiscoveryLeads.length;
      const googleMapsRequestCount = Math.min(Math.max(remainingCount, 15), 30);
      googleMapsLeads = await discoverGoogleMapsLeads({
        request: {
          ...request,
          count: googleMapsRequestCount,
        },
        location: discoveryLocation,
        queryVariants,
        maxResults: googleMapsRequestCount,
        queryLimit: 4,
        deadlineMs,
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
    Pick<VercelSearchServiceDeps, 'discoverGoogleMapsLeads'>,
): Promise<SearchJobRecord> => {
  let targetLocation = job.targetLocation as NormalizedUsLocation | undefined;

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

  if (!job.searchSeeds.length) {
    job.locationLabel = targetLocation.label;
    job.locationMode = targetLocation.mode;
    job.query =
      targetLocation.mode === 'nationwide'
        ? `${job.request.companyType} in United States`
        : buildQuery(job.request.companyType, targetLocation);
    job.searchSeeds = buildDiscoverySeeds(targetLocation);
    job.status = 'discovering';
    job.progress.currentSource = 'Google Places API';
    job.providerWarnings.push(...targetLocation.warnings);
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
        deps.discoverGoogleMapsLeads ?? discoverUsLeadsFromGoogleMaps,
        deps.discoverOsmLeads,
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
  const googlePlaces = deps.googlePlaces ?? googlePlacesProvider;
  const normalizeLocation = deps.normalizeLocation ?? normalizeUsLocation;
  const discoverGoogleMapsLeads =
    deps.discoverGoogleMapsLeads ??
    (process.env.NODE_ENV === 'test' ? undefined : discoverUsLeadsFromGoogleMaps);
  const discoverOsm = deps.discoverOsmLeads ?? discoverUsLeadsFromOsm;
  const now = deps.now ?? withNow;
  const idFactory = deps.idFactory ?? randomUUID;

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
      await store.ensureSchema();
      await store.deleteExpired(now());

      const job = await store.get(searchId);
      if (!job) {
        return null;
      }

      const next = await tickJob(job, store, {
        googlePlaces,
        normalizeLocation,
        discoverGoogleMapsLeads,
        discoverOsmLeads: discoverOsm,
        now,
      });
      return toSearchResponse(next);
    },
  };
};

export const vercelSearchService = createVercelSearchService();
