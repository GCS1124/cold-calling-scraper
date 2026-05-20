import { randomUUID } from 'node:crypto';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchProgress, SearchRequest, SearchResponse, SearchStatus } from '../types/search';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead, enrichLeads } from './lead-validation';
import { discoverUsLeadsFromOsm } from './osm-discovery';
import { googlePlacesProvider } from '../providers/google-places';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';
import { nationwideStateQueries } from './us-discovery-regions';
import { enrichLeadFromWebsite } from './website-enrichment';
import {
  createSearchJobStore,
  type SearchJobRecord,
  toSearchResponse,
} from './search-job-store';
import { resolveCategoryProfile } from './us-category-mapping';

type VercelSearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
};

type VercelSearchServiceDeps = {
  store?: ReturnType<typeof createSearchJobStore>;
  googlePlaces?: typeof googlePlacesProvider;
  normalizeLocation?: typeof normalizeUsLocation;
  discoverOsmLeads?: typeof discoverUsLeadsFromOsm;
  enrichWebsiteLead?: typeof enrichLeadFromWebsite;
  now?: () => number;
  idFactory?: () => string;
};

const jobTtlMs = 15 * 60 * 1000;
const discoveryBatchSize = 2;
const enrichmentBatchSize = 6;
const perSeedCount = 24;
const maxCandidatePool = 3000;

const withNow = () => Date.now();

const createProgress = (requestedCount: number): SearchProgress => ({
  discovered: 0,
  enriched: 0,
  totalCandidates: 0,
  requestedCount,
  qualifiedCount: 0,
  discardedCount: 0,
  blockedCount: 0,
  duplicatesRemoved: 0,
  currentSource: 'Queued',
  batchesCompleted: 0,
  estimatedRemaining: requestedCount,
});

const normalizeLead = (lead: Lead) => enrichLead(lead);

const toSearchSeeds = (location: NormalizedUsLocation) =>
  location.mode === 'nationwide' ? [...nationwideStateQueries] : [location.label];

const rankDiscoveryCandidates = (leads: Lead[]) =>
  [...leads].sort((left, right) => {
    const leftSignal =
      Number(left.source.includes('Google Places')) * 8 +
      Number(left.hasWebsite) * 5 +
      Number(left.hasPhone) * 5 +
      Number(Boolean(left.website && left.mobile)) * 4 +
      (left.sourceScore ?? 0) / 20;
    const rightSignal =
      Number(right.source.includes('Google Places')) * 8 +
      Number(right.hasWebsite) * 5 +
      Number(right.hasPhone) * 5 +
      Number(Boolean(right.website && right.mobile)) * 4 +
      (right.sourceScore ?? 0) / 20;

    return rightSignal - leftSignal || right.confidence - left.confidence || left.name.localeCompare(right.name);
  });

const refreshProgress = (job: SearchJobRecord) => {
  const qualifiedCount = job.leads.filter((lead) => lead.qualified).length;
  const blockedCount = job.leads.filter((lead) =>
    ['blocked_google', 'blocked_website'].includes(lead.rejectionReason ?? ''),
  ).length;

  job.progress.discovered = job.leads.length;
  job.progress.totalCandidates = job.leads.length;
  job.progress.qualifiedCount = qualifiedCount;
  job.progress.discardedCount = job.leads.filter((lead) => !lead.qualified).length;
  job.progress.blockedCount = blockedCount;
  job.progress.estimatedRemaining = Math.max(0, job.request.count - qualifiedCount);
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

const mergeLeads = (job: SearchJobRecord, incoming: Lead[]) => {
  const merged = [...job.leads, ...incoming];
  const normalized = enrichLeads(merged).map(normalizeLead);
  const { leads, duplicatesRemoved } = dedupeWithCount(normalized);
  job.progress.duplicatesRemoved += duplicatesRemoved;
  job.leads = trimCandidatePool(leads, job.request.count);
  refreshProgress(job);
};

const buildQuery = (companyType: string, location: NormalizedUsLocation) =>
  `${companyType} in ${location.label}`;

const discoverRegionLeads = async (
  request: SearchRequest,
  location: NormalizedUsLocation,
  googlePlaces: typeof googlePlacesProvider,
  discoverOsmLeads: typeof discoverUsLeadsFromOsm,
  profile = resolveCategoryProfile(request.companyType),
) => {
  const googleRequest: SearchRequest = {
    ...request,
    city: location.label,
    count: perSeedCount,
  };

  const query = buildQuery(request.companyType, location);
  const warnings: ProviderWarning[] = [...profile.warnings, ...location.warnings];

  let googleLeads: Lead[] = [];
  try {
    googleLeads = await googlePlaces.fetchLeads({
      rawQuery: request.companyType,
      query,
      request: googleRequest,
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
  if (googleLeads.length < Math.ceil(perSeedCount / 2)) {
    try {
      osmLeads = await discoverOsmLeads({
        request: googleRequest,
        location,
        profile,
      });
    } catch (error) {
      warnings.push({
        providerId: 'osm-discovery',
        providerName: 'OpenStreetMap',
        message:
          error instanceof Error ? error.message : 'OpenStreetMap discovery failed',
      });
    }
  }

  return {
    leads: [...googleLeads, ...osmLeads],
    warnings,
  };
};

const enrichMissingEmails = async (
  job: SearchJobRecord,
  enrichWebsiteLead: typeof enrichLeadFromWebsite,
) => {
  const targets = rankDiscoveryCandidates(job.leads)
    .filter((lead) => lead.website && !lead.verifiedEmail)
    .slice(0, enrichmentBatchSize);

  if (!targets.length) {
    return false;
  }

  job.progress.currentSource = 'Website Crawl';

  for (const lead of targets) {
    const result = await enrichWebsiteLead(lead);
    job.providerWarnings.push(...result.warnings);

    const nextLeads = job.leads.map((current) =>
      current.id === lead.id ? result.lead : current,
    );
    const normalized = enrichLeads(nextLeads).map(normalizeLead);
    const { leads, duplicatesRemoved } = dedupeWithCount(normalized);

    job.progress.duplicatesRemoved += duplicatesRemoved;
    job.progress.enriched += 1;
    job.leads = trimCandidatePool(leads, job.request.count);
    refreshProgress(job);
  }

  return true;
};

const tickJob = async (
  job: SearchJobRecord,
  store: ReturnType<typeof createSearchJobStore>,
  deps: Required<Pick<VercelSearchServiceDeps, 'googlePlaces' | 'normalizeLocation' | 'discoverOsmLeads' | 'enrichWebsiteLead' | 'now'>>,
): Promise<SearchJobRecord> => {
  if (job.status === 'failed' || job.status === 'complete') {
    return job;
  }

  const normalizedLocation = await deps.normalizeLocation(job.request.city);
  if (!job.searchSeeds.length) {
    job.locationLabel = normalizedLocation.label;
    job.locationMode = normalizedLocation.mode;
    job.query =
      normalizedLocation.mode === 'nationwide'
        ? `${job.request.companyType} in United States`
        : buildQuery(job.request.companyType, normalizedLocation);
    job.searchSeeds = toSearchSeeds(normalizedLocation);
    job.status = 'discovering';
    job.progress.currentSource = 'Google Places';
    job.providerWarnings.push(...normalizedLocation.warnings);
  }

  if (job.nextSeedIndex < job.searchSeeds.length) {
    job.status = 'discovering';
    job.progress.currentSource = 'Google Places';

    let processed = 0;
    while (job.nextSeedIndex < job.searchSeeds.length && processed < discoveryBatchSize) {
      const seed = job.searchSeeds[job.nextSeedIndex];
      const regionalLocation = await deps.normalizeLocation(seed);
      const { leads, warnings } = await discoverRegionLeads(
        job.request,
        regionalLocation,
        deps.googlePlaces,
        deps.discoverOsmLeads,
        resolveCategoryProfile(job.request.companyType),
      );

      job.providerWarnings.push(...warnings);
      mergeLeads(job, leads);
      job.nextSeedIndex += 1;
      job.progress.batchesCompleted += 1;
      processed += 1;
      job.expiresAt = withNow() + jobTtlMs;

      if (job.progress.qualifiedCount >= job.request.count) {
        break;
      }
    }
  }

  job.discoveryComplete = job.nextSeedIndex >= job.searchSeeds.length;

  if (job.progress.qualifiedCount < job.request.count && job.discoveryComplete) {
    const enriched = await enrichMissingEmails(job, deps.enrichWebsiteLead);
    if (enriched) {
      job.progress.batchesCompleted += 1;
      job.expiresAt = withNow() + jobTtlMs;
    }
  }

  if (job.progress.qualifiedCount >= job.request.count) {
    job.status = 'complete';
    job.progress.currentSource = 'Complete';
  } else if (!job.discoveryComplete) {
    job.status = 'discovering';
    job.progress.currentSource = 'Google Places';
  } else if (job.leads.some((lead) => lead.website && !lead.verifiedEmail)) {
    job.status = 'enriching';
    job.progress.currentSource = 'Website Crawl';
  } else {
    job.status = 'complete';
    job.progress.currentSource = 'Complete';
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
  const discoverOsm = deps.discoverOsmLeads ?? discoverUsLeadsFromOsm;
  const enrichWebsiteLead = deps.enrichWebsiteLead ?? enrichLeadFromWebsite;
  const now = deps.now ?? withNow;
  const idFactory = deps.idFactory ?? randomUUID;

  return {
    async startSearch(request) {
      await store.ensureSchema();
      await store.deleteExpired(now());

      const searchId = idFactory();
      const createdAt = now();
      let job: SearchJobRecord = {
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
        expiresAt: createdAt + jobTtlMs,
        createdAt,
        updatedAt: createdAt,
      };

      await store.upsert(job);
      job = await tickJob(job, store, {
        googlePlaces,
        normalizeLocation,
        discoverOsmLeads: discoverOsm,
        enrichWebsiteLead,
        now,
      });

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
        discoverOsmLeads: discoverOsm,
        enrichWebsiteLead,
        now,
      });
      return toSearchResponse(next);
    },
  };
};

export const vercelSearchService = createVercelSearchService();
