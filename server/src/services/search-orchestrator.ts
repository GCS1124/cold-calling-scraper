import { randomUUID } from 'node:crypto';

import pLimit from 'p-limit';

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
import { discoverUsLeadsFromGoogleMaps } from './google-maps-discovery';
import { discoverUsLeadsFromOsm } from './osm-discovery';
import { nationwideStateQueries } from './us-discovery-regions';
import { resolveCategoryProfile } from './us-category-mapping';
import { normalizeUsLocation, type NormalizedUsLocation } from './us-location';
import { enrichLeadFromWebsite } from './website-enrichment';

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
};

type SearchService = {
  startSearch: (request: SearchRequest) => Promise<SearchResponse>;
  getSearch: (searchId: string) => Promise<SearchResponse | null>;
};

type SearchDeps = {
  normalizeLocation?: (rawLocation: string) => Promise<NormalizedUsLocation>;
  discoverGoogleLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
  }) => Promise<Lead[]>;
  discoverOsmLeads?: (args: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    profile: ReturnType<typeof resolveCategoryProfile>;
  }) => Promise<Lead[]>;
  enrichLead?: (lead: Lead) => Promise<{ lead: Lead; warnings: ProviderWarning[] }>;
  schedule?: (task: () => Promise<void>) => void;
  now?: () => number;
  idFactory?: () => string;
};

const jobTtlMs = 15 * 60 * 1000;
const enrichmentBatchSize = 25;
const enrichmentConcurrency = pLimit(3);
const googleDiscoveryTimeoutMs = 20000;
const osmDiscoveryTimeoutMs = 20000;
const maxCandidatePool = 3000;
const minimumEnrichmentTarget = 60;

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

const rankLeads = (leads: Lead[]) =>
  [...leads].sort((left, right) => {
    const leftScore =
      Number(left.qualified) * 6 +
      Number(left.hasEmail) * 4 +
      Number(left.hasPhone) * 4 +
      Number(left.hasWebsite) * 3 +
      (left.sourceScore ?? 0) / 25;
    const rightScore =
      Number(right.qualified) * 6 +
      Number(right.hasEmail) * 4 +
      Number(right.hasPhone) * 4 +
      Number(right.hasWebsite) * 3 +
      (right.sourceScore ?? 0) / 25;

    return (
      rightScore - leftScore ||
      right.confidence - left.confidence ||
      left.name.localeCompare(right.name)
    );
  });

const rankDiscoveryCandidates = (leads: Lead[]) =>
  [...leads].sort((left, right) => {
    const leftSignal =
      Number(left.source.includes('Google Maps')) * 6 +
      Number(left.hasWebsite) * 5 +
      Number(left.hasPhone) * 5 +
      Number(Boolean(left.website && left.mobile)) * 4 +
      (left.sourceScore ?? 0) / 20;
    const rightSignal =
      Number(right.source.includes('Google Maps')) * 6 +
      Number(right.hasWebsite) * 5 +
      Number(right.hasPhone) * 5 +
      Number(Boolean(right.website && right.mobile)) * 4 +
      (right.sourceScore ?? 0) / 20;

    return (
      rightSignal - leftSignal ||
      right.confidence - left.confidence ||
      left.name.localeCompare(right.name)
    );
  });

const hasEnrichmentTargets = (job: SearchJob) =>
  job.leads.some(
    (lead) =>
      lead.website &&
      !lead.qualified &&
      lead.rejectionReason !== 'blocked_website' &&
      lead.rejectionReason !== 'blocked_google',
  );

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
  qualifiedCount: 0,
  discardedCount: 0,
  blockedCount: 0,
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

const trimCandidatePool = (leads: Lead[], requestedCount: number) =>
  rankDiscoveryCandidates(leads).slice(0, Math.min(maxCandidatePool, requestedCount * 5));

const upsertLeads = (job: SearchJob, incoming: Lead[]) => {
  const merged = [...job.leads, ...incoming];
  const { leads, duplicatesRemoved } = dedupeWithCount(enrichLeads(merged));
  job.progress.duplicatesRemoved += duplicatesRemoved;
  job.leads = trimCandidatePool(leads, job.request.count);
  refreshProgress(job);
};

const runRegionalDiscovery = async (
  job: SearchJob,
  request: SearchRequest,
  location: NormalizedUsLocation,
  profile: ReturnType<typeof resolveCategoryProfile>,
  discoverGoogleLeads: NonNullable<SearchDeps['discoverGoogleLeads']>,
  discoverOsmLeads: NonNullable<SearchDeps['discoverOsmLeads']>,
) => {
  job.progress.currentSource =
    location.mode === 'nationwide' ? 'Nationwide Discovery' : 'Hybrid Discovery';

  await Promise.all([
    (async () => {
      try {
        const googleLeads = await withTimeout(
          discoverGoogleLeads({
            request,
            location,
          }),
          googleDiscoveryTimeoutMs,
          'Google Maps discovery timed out before the batch completed',
        );
        upsertLeads(job, googleLeads);
        job.progress.batchesCompleted += 1;
      } catch (error) {
        job.providerWarnings.push({
          providerId: 'google-maps',
          providerName: 'Google Maps',
          message:
            error instanceof Error
              ? error.message
              : 'Google Maps discovery failed',
        });
        job.progress.blockedCount += 1;
      }
    })(),
    (async () => {
      try {
        const osmLeads = await withTimeout(
          discoverOsmLeads({
            request,
            location,
            profile,
          }),
          osmDiscoveryTimeoutMs,
          'OpenStreetMap discovery timed out before the batch completed',
        );
        upsertLeads(job, osmLeads);
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
  const discoverGoogleLeads = deps.discoverGoogleLeads ?? discoverUsLeadsFromGoogleMaps;
  const discoverOsmLeads = deps.discoverOsmLeads ?? discoverUsLeadsFromOsm;
  const enrichLead = deps.enrichLead ?? enrichLeadFromWebsite;
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

  const runEnrichment = async (job: SearchJob) => {
    const shortlistSize = Math.max(minimumEnrichmentTarget, job.request.count * 2);
  const targets = rankDiscoveryCandidates(job.leads)
    .filter(
      (lead) =>
        lead.website &&
        !lead.qualified &&
        lead.rejectionReason !== 'blocked_website' &&
        lead.rejectionReason !== 'blocked_google',
    )
    .slice(0, shortlistSize);
    if (!targets.length) {
      return;
    }

    job.status = 'enriching';
    job.progress.currentSource = 'Website Crawl';

    for (let index = 0; index < targets.length; index += enrichmentBatchSize) {
      const batch = targets.slice(index, index + enrichmentBatchSize);
      const results = await Promise.all(
        batch.map((lead) =>
          enrichmentConcurrency(async () => {
            const result = await enrichLead(lead);
            return { lead, result };
          }),
        ),
      );

      job.progress.batchesCompleted += 1;
      job.progress.currentSource = 'Website Crawl';
      job.progress.enriched += results.length;

      for (const { lead, result } of results) {
        job.providerWarnings.push(...result.warnings);
        const nextLeads = job.leads.map((current) =>
          current.id === lead.id ? result.lead : current,
        );
        const { leads, duplicatesRemoved } = dedupeWithCount(enrichLeads(nextLeads));
        job.progress.duplicatesRemoved += duplicatesRemoved;
        job.leads = trimCandidatePool(leads, job.request.count);
        refreshProgress(job);
        job.expiresAt = now() + jobTtlMs;
      }

      if (job.progress.qualifiedCount >= job.request.count) {
        break;
      }
    }
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

    const discoveryLocations =
      location.mode === 'nationwide'
        ? [
            location,
            ...(await Promise.all(
              nationwideStateQueries.map((seed) => normalizeLocation(seed)),
            )),
          ]
        : [location];

    for (const regionalLocation of discoveryLocations) {
      if (job.progress.qualifiedCount >= job.request.count) {
        break;
      }

      await runRegionalDiscovery(
        job,
        job.request,
        regionalLocation,
        profile,
        discoverGoogleLeads,
        discoverOsmLeads,
      );
    }

    job.status = 'qualifying';
    job.progress.currentSource = 'Qualification';
    refreshProgress(job);

    if (job.progress.qualifiedCount < job.request.count) {
      try {
        await runEnrichment(job);
      } catch (error) {
        markFailed(job, {
          providerId: 'website-crawl',
          providerName: 'Website Crawl',
          message:
            error instanceof Error ? error.message : 'Website enrichment failed',
        });
        return;
      }
    }

    if (job.progress.qualifiedCount >= job.request.count) {
      job.status = 'complete';
      job.progress.currentSource = 'Complete';
    } else if (hasEnrichmentTargets(job)) {
      job.status = 'enriching';
      job.progress.currentSource = 'Website Crawl';
    } else {
      job.status = 'qualifying';
      job.progress.currentSource = 'Qualification';
    }
    refreshProgress(job);
  };

  return {
    async startSearch(request) {
      cleanupExpiredJobs(jobs, now);

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
        expiresAt: now() + jobTtlMs,
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
