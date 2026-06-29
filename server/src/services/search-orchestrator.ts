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
import { googlePlacesProvider } from '../providers/google-places';
import { discoverUsLeadsFromOsm } from './osm-discovery';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { resolveCategoryProfile } from './us-category-mapping';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';
import { filterLeadsForLocation } from './location-acceptance';
import { buildDiscoverySeeds } from './discovery-seeds';

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
};

type SearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
};

type SearchDeps = {
  normalizeLocation?: (rawLocation: string) => Promise<NormalizedUsLocation>;
  enrichLead?: (lead: Lead) => Lead | Promise<Lead>;
  discoverGoogleLeads?: typeof googlePlacesProvider | ((args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    queryVariants: string[];
    deadlineMs?: number;
  }) => Promise<Lead[]>);
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
const osmDiscoveryTimeoutMs = 20000;
const discoveryStallMs = 20000;
const maxCandidatePool = 3000;

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
      Number(left.hasWebsite) * 5 +
      Number(left.hasPhone) * 5 +
      Number(Boolean(left.address)) * 2 +
      Number(Boolean(left.website && left.mobile)) * 4 +
      (left.sourceScore ?? 0) / 20;
    const rightSignal =
      Number(right.source.includes('Google Places')) * 6 +
      Number(right.source.includes('Google Maps')) * 6 +
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

const refreshProgress = (job: SearchJob) => {
  job.progress.discovered = job.leads.length;
  job.progress.totalCandidates = job.leads.length;
  job.progress.foundCount = job.leads.length;
  job.progress.estimatedRemaining = Math.max(0, job.request.count - job.leads.length);
};

const trimCandidatePool = (leads: Lead[], requestedCount: number) =>
  rankDiscoveryCandidates(leads).slice(0, Math.min(maxCandidatePool, requestedCount * 5));

const upsertLeads = (job: SearchJob, incoming: Lead[], now: () => number) => {
  const previousCount = job.leads.length;
  const merged = [...job.leads, ...enrichLeads(incoming)];
  const { leads, duplicatesRemoved } = dedupeWithCount(merged);
  job.progress.duplicatesRemoved += duplicatesRemoved;
  job.leads = trimCandidatePool(leads, job.request.count);
  if (job.leads.length > previousCount) {
    job.lastProgressAt = now();
  }
  refreshProgress(job);
};

const runRegionalDiscovery = async (
  job: SearchJob,
  request: SearchRequest,
  targetLocation: NormalizedUsLocation,
  discoveryLocation: NormalizedUsLocation,
  profile: ReturnType<typeof resolveCategoryProfile>,
  discoverGoogleLeads: NonNullable<SearchDeps['discoverGoogleLeads']>,
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

  await Promise.all([
    (async () => {
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
        job.providerWarnings.push({
          providerId: 'google-places',
          providerName: 'Google Places',
          message:
            error instanceof Error
              ? error.message
              : 'Google Places discovery failed',
        });
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
        job.providerWarnings.push({
          providerId: 'osm-discovery',
          providerName: 'OpenStreetMap',
          message:
            error instanceof Error ? error.message : 'OSM discovery failed',
        });
      }
    })(),
  ]);
};

export const createSearchService = (deps: SearchDeps = {}): SearchService => {
  const jobs = new Map<string, SearchJob>();
  const normalizeLocation = deps.normalizeLocation ?? normalizeUsLocation;
  const discoverGoogleLeads = deps.discoverGoogleLeads ?? googlePlacesProvider;
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

      if (job.progress.foundCount < job.request.count && now() - job.lastProgressAt >= discoveryStallMs) {
        job.providerWarnings.push({
          providerId: 'discovery-limit',
          providerName: 'Discovery',
          message:
            'No new businesses were returned after 20 seconds. Search stopped after verifying the available results.',
        });
        break;
      }

      await runRegionalDiscovery(
        job,
        job.request,
        location,
        regionalLocation,
        profile,
        discoverGoogleLeads,
        discoverOsmLeads,
        now,
      );

      if (job.progress.foundCount < job.request.count && now() - job.lastProgressAt >= discoveryStallMs) {
        job.providerWarnings.push({
          providerId: 'discovery-limit',
          providerName: 'Discovery',
          message:
            'No new businesses were returned after 20 seconds. Search stopped after verifying the available results.',
        });
        break;
      }
    }

    refreshProgress(job);

    if (job.progress.foundCount >= job.request.count) {
      job.status = 'complete';
      job.progress.currentSource = 'Complete';
    } else {
      job.status = 'complete';
      job.progress.currentSource = 'Complete';
    }
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
