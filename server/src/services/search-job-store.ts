import { Pool, type PoolConfig } from 'pg';

import type { Lead, ResearchCandidate, ReviewCandidate, ReviewCandidateReason } from '../types/lead';
import type {
  ProviderWarning,
  SearchProgress,
  SearchRequest,
  SearchResponse,
  SearchStatus,
} from '../types/search';
import { deduplicateLeads } from './lead-deduplication';
import { enrichLead } from './lead-validation';
import { enforcePhoneRequirement } from './phone-requirement';
import { noUsableResultsWarning } from './search-finalization';
import { persistNormalizedResearch } from './research-normalizer';
import type { NormalizedUsLocation } from './us-location';
import { normalizeLeadSourceMode } from './search-source-mode';
import {
  buildSearchExecutionContract,
  buildSearchResponseContract,
  type SearchCallbackContract,
} from '../../../shared/search-contract';
import { buildLeadQualitySummary } from './quality-summary';
import { SearchIdempotencyConflictError } from './search-idempotency';
import { filterSuppressedLeads } from '../../../shared/lead-feedback';
import {
  isCallbackDue,
  normalizeCallbackRequest,
  sanitizeCallbackState,
  type SearchCallbackState,
} from './search-completion-callback';
import { isPublicHttpUrl } from '../utils/public-url';

export type SearchLocationMode =
  | 'local'
  | 'nationwide'
  | 'timezone'
  | 'region'
  | 'state';

export type AiWorkflowStage =
  | 'source_discovery'
  | 'public_listing_continuation'
  | 'gemini_public_research'
  | 'website_enrichment'
  | 'final_fusion'
  | 'completed';

/** Durable AI-mode cursor. Each stage is persisted between sub-60-second ticks. */
export type AiWorkflowState = {
  startedAt: number;
  logicalDeadlineAt: number;
  stage: AiWorkflowStage;
  /** Number of bounded website batches completed in the durable search. */
  websitePasses?: number;
  /** Next deterministic OSM spatial-box cursor for the generic listing stage. */
  osmBoxCursor?: number;
  /** Total deterministic OSM spatial boxes for the current normalized location. */
  osmTotalBoxes?: number;
  /** Number of bounded OSM continuation ticks already completed. */
  osmContinuationPasses?: number;
  /** Whether the one grounded Gemini pass remains queued after source discovery. */
  geminiPending?: boolean;
  /**
   * Canonical-host representatives awaiting bounded public website enrichment.
   * These lead ids, rather than raw URLs, make the queue safe to persist and
   * resume after a serverless invocation ends.
   */
  websiteQueue?: string[];
  /** Number of canonical hosts admitted to this logical search's website queue. */
  websiteTotalHosts?: number;
  /** Ineligible, duplicate, or cap-excluded website candidates. */
  websiteSkippedCount?: number;
  /** Prevents the snapshot metric from double-counting queued hosts per tick. */
  websiteObservedReported?: boolean;
};

export type SearchJobRecord = {
  schemaVersion: number;
  searchId: string;
  ownerId?: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
  request: SearchRequest;
  callback?: SearchCallbackState;
  query: string;
  locationLabel: string;
  locationMode: SearchLocationMode;
  targetLocation?: NormalizedUsLocation;
  status: SearchStatus;
  progress: SearchProgress;
  leads: Lead[];
  researchCandidates?: ResearchCandidate[];
  reviewCandidates?: ReviewCandidate[];
  aiWorkflow?: AiWorkflowState;
  providerWarnings: ProviderWarning[];
  searchSeeds: string[];
  nextSeedIndex: number;
  /** Stable lead ids used to resume public LinkedIn contact enrichment in batches. */
  enrichmentQueue?: string[];
  enrichmentCursor?: number;
  discoveryComplete: boolean;
  googleMapsUnavailable?: boolean;
  lastProgressAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  processingToken?: string;
  processingUntil?: number;
  cancelRequested?: boolean;
};

export type SearchJobStore = {
  ensureSchema: () => Promise<void>;
  get: (searchId: string, ownerId?: string) => Promise<SearchJobRecord | null>;
  create: (job: SearchJobRecord) => Promise<{
    job: SearchJobRecord;
    created: boolean;
  }>;
  getByIdempotencyKey: (
    idempotencyKey: string,
    requestFingerprint: string,
    now: number,
    ownerId?: string,
  ) => Promise<SearchJobRecord | null>;
  claim: (
    searchId: string,
    now: number,
    leaseMs: number,
    token: string,
    ownerId?: string,
  ) => Promise<SearchJobRecord | null>;
  upsert: (job: SearchJobRecord) => Promise<void>;
  requestCancel: (
    searchId: string,
    now: number,
    ownerId?: string,
  ) => Promise<SearchJobRecord | null>;
  deleteExpired: (now: number) => Promise<void>;
  close?: () => Promise<void>;
};

export class SearchPersistenceError extends Error {
  readonly code = 'SEARCH_PERSISTENCE_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'SearchPersistenceError';
  }
}

export const isSearchPersistenceError = (
  error: unknown,
): error is SearchPersistenceError =>
  error instanceof SearchPersistenceError ||
  (error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'SEARCH_PERSISTENCE_UNAVAILABLE');

export const CURRENT_SCHEMA_VERSION = 9;

const DEFAULT_JOB_TTL_MS = 1000 * 60 * 60 * 6;
const MEMORY_MAX_JOBS = Number(process.env.SEARCH_JOB_MEMORY_MAX_JOBS ?? 500);
const POSTGRES_STATEMENT_TIMEOUT_MS = Number(
  process.env.SEARCH_JOB_POSTGRES_STATEMENT_TIMEOUT_MS ?? 10_000,
);

const normalizeConnectionString = (url: string) => {
  try {
    const parsed = new URL(url);

    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslaccept']) {
      parsed.searchParams.delete(key);
    }

    return parsed.toString();
  } catch {
    return url;
  }
};

const connectionString =
  process.env.POSTGRES_URL_NON_POOLING?.trim() ||
  process.env.POSTGRES_PRISMA_URL?.trim() ||
  process.env.POSTGRES_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  '';

const sanitizedConnectionString = connectionString
  ? normalizeConnectionString(connectionString)
  : '';

const isVercelRuntime = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);

const shouldUseSsl = (url: string) => {
  if (!url) return false;

  if (/localhost|127\.0\.0\.1|\.local/i.test(url)) {
    return false;
  }

  if (/[?&]sslmode=disable/i.test(url)) {
    return false;
  }

  return true;
};

let pool: Pool | null = null;

const getPool = () => {
  if (!connectionString) {
    return null;
  }

  if (!pool) {
    const config: PoolConfig = {
      connectionString: sanitizedConnectionString,
      max: Number(process.env.SEARCH_JOB_POSTGRES_POOL_MAX ?? 2),
      idleTimeoutMillis: Number(process.env.SEARCH_JOB_POSTGRES_IDLE_TIMEOUT_MS ?? 10_000),
      connectionTimeoutMillis: Number(process.env.SEARCH_JOB_POSTGRES_CONNECT_TIMEOUT_MS ?? 6_000),
      statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
      query_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
      ssl: shouldUseSsl(connectionString)
        ? {
            rejectUnauthorized:
              process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === 'true',
          }
        : undefined,
    };

    pool = new Pool(config);

    pool.on('error', (error) => {
      console.error('[search-job-store] idle postgres client error', error);
    });
  }

  return pool;
};

// Feedback and suppression use the same bounded pool as durable search jobs.
// Keeping one pool avoids an extra serverless connection budget per request.
export const getSearchDatabasePool = () => getPool();
export const hasSearchDatabase = () => Boolean(connectionString);
export const isSearchJobVercelRuntime = () => isVercelRuntime;

const nowMs = () => Date.now();

const normalizeSearchId = (searchId: string) => searchId.trim();

const isValidSearchId = (searchId: string) => {
  const normalized = normalizeSearchId(searchId);

  return (
    normalized.length >= 8 &&
    normalized.length <= 128 &&
    /^[a-zA-Z0-9:_-]+$/.test(normalized)
  );
};

const uniqueStrings = (values: string[]) => {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
};

const warningKey = (warning: ProviderWarning) => {
  return [
    warning.providerId,
    warning.providerName,
    warning.message,
  ].join('|');
};

const dedupeWarnings = (warnings: ProviderWarning[]) => {
  const seen = new Set<string>();
  const deduped: ProviderWarning[] = [];

  for (const warning of warnings) {
    const key = warningKey(warning);

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(warning);
    }
  }

  return deduped;
};

const clampProgress = (progress: SearchProgress): SearchProgress => {
  const safeProgress = {
    ...progress,
  };

  for (const [key, value] of Object.entries(safeProgress)) {
    if (typeof value === 'number') {
      (safeProgress as Record<string, unknown>)[key] = Math.max(0, value);
    }
  }

  return safeProgress;
};

const normalizeLocationMode = (mode: unknown): SearchLocationMode => {
  if (
    mode === 'local' ||
    mode === 'nationwide' ||
    mode === 'timezone' ||
    mode === 'region' ||
    mode === 'state'
  ) {
    return mode;
  }

  return 'local';
};

const normalizeAiWorkflow = (value: unknown): AiWorkflowState | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const workflow = value as Partial<AiWorkflowState>;
  const stage: AiWorkflowStage | undefined =
    workflow.stage === 'source_discovery' ||
    workflow.stage === 'public_listing_continuation' ||
    workflow.stage === 'gemini_public_research' ||
    workflow.stage === 'website_enrichment' ||
    workflow.stage === 'final_fusion' ||
    workflow.stage === 'completed'
      ? workflow.stage
      : undefined;
  const startedAt = Number(workflow.startedAt);
  const logicalDeadlineAt = Number(workflow.logicalDeadlineAt);
  if (!stage || !Number.isFinite(startedAt) || !Number.isFinite(logicalDeadlineAt)) return undefined;
  const osmTotalBoxes = Number.isFinite(workflow.osmTotalBoxes)
    ? Math.max(0, Math.floor(workflow.osmTotalBoxes as number))
    : undefined;
  const rawOsmBoxCursor = Number.isFinite(workflow.osmBoxCursor)
    ? Math.max(0, Math.floor(workflow.osmBoxCursor as number))
    : undefined;
  const osmBoxCursor = rawOsmBoxCursor === undefined
    ? undefined
    : osmTotalBoxes === undefined
      ? rawOsmBoxCursor
      : Math.min(osmTotalBoxes, rawOsmBoxCursor);

  return {
    startedAt: Math.max(0, Math.floor(startedAt)),
    logicalDeadlineAt: Math.max(Math.floor(startedAt), Math.floor(logicalDeadlineAt)),
    stage,
    ...(Number.isFinite(workflow.websitePasses)
      ? { websitePasses: Math.max(0, Math.floor(workflow.websitePasses as number)) }
      : {}),
    ...(osmBoxCursor === undefined ? {} : { osmBoxCursor }),
    ...(osmTotalBoxes === undefined ? {} : { osmTotalBoxes }),
    ...(Number.isFinite(workflow.osmContinuationPasses)
      ? {
          osmContinuationPasses: Math.max(
            0,
            Math.floor(workflow.osmContinuationPasses as number),
          ),
        }
      : {}),
    ...(typeof workflow.geminiPending === 'boolean'
      ? { geminiPending: workflow.geminiPending }
      : {}),
    ...(Array.isArray(workflow.websiteQueue)
      ? { websiteQueue: uniqueStrings(workflow.websiteQueue).slice(0, 120) }
      : {}),
    ...(Number.isFinite(workflow.websiteTotalHosts)
      ? { websiteTotalHosts: Math.max(0, Math.min(120, Math.floor(workflow.websiteTotalHosts as number))) }
      : {}),
    ...(Number.isFinite(workflow.websiteSkippedCount)
      ? { websiteSkippedCount: Math.max(0, Math.floor(workflow.websiteSkippedCount as number)) }
      : {}),
    ...(typeof workflow.websiteObservedReported === 'boolean'
      ? { websiteObservedReported: workflow.websiteObservedReported }
      : {}),
  };
};

const normalizeStoredLeads = (value: unknown): Lead[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }

    try {
      return [enrichLead(candidate as Lead)];
    } catch {
      // A malformed persisted record must never break polling or leak an
      // unvalidated URL/contact claim into the response.
      return [];
    }
  });
};

const readStoredString = (value: unknown, maxLength: number) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const normalizeStoredPublicUrl = (value: unknown) => {
  const candidate = readStoredString(value, 2_048);
  if (!candidate || !isPublicHttpUrl(candidate)) {
    return '';
  }

  try {
    const url = new URL(candidate);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
};

const normalizeStoredResearchCandidates = (value: unknown): ResearchCandidate[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }

    const record = candidate as unknown as Record<string, unknown>;
    const id = readStoredString(record.id, 160);
    if (!id) {
      return [];
    }

    const sourceUrls = Array.isArray(record.sourceUrls)
      ? [...new Set(record.sourceUrls.map(normalizeStoredPublicUrl).filter(Boolean))].slice(0, 12)
      : [];
    const sourceTitles = Array.isArray(record.sourceTitles)
      ? [...new Set(record.sourceTitles.map((title) => readStoredString(title, 240)).filter(Boolean))].slice(0, 12)
      : undefined;
    const socialLinks = Array.isArray(record.socialLinks)
      ? record.socialLinks.flatMap((link) => {
          if (!link || typeof link !== 'object') return [];
          const social = link as Record<string, unknown>;
          const url = normalizeStoredPublicUrl(social.url);
          const platform = readStoredString(social.platform, 80);
          return url && platform ? [{ platform, url }] : [];
        }).slice(0, 12)
      : undefined;
    const status = record.status === 'needs_phone_validation' || record.status === 'needs_source_review'
      ? record.status
      : 'needs_source_review';
    const discoveredAt = readStoredString(record.discoveredAt, 80) || new Date().toISOString();

    return [{
      id,
      ...(readStoredString(record.name, 180) ? { name: readStoredString(record.name, 180) } : {}),
      ...(readStoredString(record.personName, 180) ? { personName: readStoredString(record.personName, 180) } : {}),
      ...(readStoredString(record.organizationName, 220) ? { organizationName: readStoredString(record.organizationName, 220) } : {}),
      ...(readStoredString(record.originalRole, 180) ? { originalRole: readStoredString(record.originalRole, 180) } : {}),
      ...(readStoredString(record.location, 180) ? { location: readStoredString(record.location, 180) } : {}),
      ...(normalizeStoredPublicUrl(record.website) ? { website: normalizeStoredPublicUrl(record.website) } : {}),
      ...(normalizeStoredPublicUrl(record.profileUrl) ? { profileUrl: normalizeStoredPublicUrl(record.profileUrl) } : {}),
      ...(readStoredString(record.reportedPhone, 80) ? { reportedPhone: readStoredString(record.reportedPhone, 80) } : {}),
      ...(readStoredString(record.reportedEmail, 240) ? { reportedEmail: readStoredString(record.reportedEmail, 240) } : {}),
      ...(socialLinks?.length ? { socialLinks } : {}),
      sourceUrls,
      ...(sourceTitles?.length ? { sourceTitles } : {}),
      ...(readStoredString(record.evidence, 2_000) ? { evidence: readStoredString(record.evidence, 2_000) } : {}),
      grounded: Boolean(record.grounded) && sourceUrls.length > 0,
      status,
      discoveredAt,
    } satisfies ResearchCandidate];
  }).slice(0, 100);
};

const reviewCandidateReasons = new Set<ReviewCandidateReason>([
  'missing_public_phone',
  'invalid_public_phone',
  'missing_source_evidence',
  'category_mismatch',
  'location_mismatch',
  'organization_unmatched',
  'organization_ambiguous',
  'former_or_conflicting',
  'website_timeout',
  'website_blocked',
  'provider_timeout',
  'provider_blocked',
  'provider_rate_limited',
  'deferred_by_budget',
]);

const normalizeStoredReviewCandidates = (value: unknown): ReviewCandidate[] => {
  if (!Array.isArray(value)) return [];

  const normalized = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const record = candidate as Record<string, unknown>;
    const id = readStoredString(record.id, 180);
    const providerId = readStoredString(record.providerId, 120);
    const providerName = readStoredString(record.providerName, 160);
    const reason = readStoredString(record.reason, 80) as ReviewCandidateReason;
    if (!id || !providerId || !providerName || !reviewCandidateReasons.has(reason)) return [];

    const sourceUrls = Array.isArray(record.sourceUrls)
      ? [...new Set(record.sourceUrls.map(normalizeStoredPublicUrl).filter(Boolean))].slice(0, 12)
      : [];
    const sourceTitles = Array.isArray(record.sourceTitles)
      ? [...new Set(record.sourceTitles.map((title) => readStoredString(title, 240)).filter(Boolean))].slice(0, 12)
      : undefined;
    const relatedLeadIds = Array.isArray(record.relatedLeadIds)
      ? [...new Set(record.relatedLeadIds.map((leadId) => readStoredString(leadId, 180)).filter(Boolean))].slice(0, 12)
      : undefined;
    const discoveredAt = readStoredString(record.discoveredAt, 80) || new Date().toISOString();

    return [{
      id,
      providerId,
      providerName,
      reason,
      ...(readStoredString(record.reasonDetail, 1_000)
        ? { reasonDetail: readStoredString(record.reasonDetail, 1_000) }
        : {}),
      ...(readStoredString(record.name, 180) ? { name: readStoredString(record.name, 180) } : {}),
      ...(readStoredString(record.personName, 180) ? { personName: readStoredString(record.personName, 180) } : {}),
      ...(readStoredString(record.organizationName, 220) ? { organizationName: readStoredString(record.organizationName, 220) } : {}),
      ...(readStoredString(record.originalRole, 180) ? { originalRole: readStoredString(record.originalRole, 180) } : {}),
      ...(readStoredString(record.location, 240) ? { location: readStoredString(record.location, 240) } : {}),
      ...(normalizeStoredPublicUrl(record.website) ? { website: normalizeStoredPublicUrl(record.website) } : {}),
      ...(normalizeStoredPublicUrl(record.profileUrl) ? { profileUrl: normalizeStoredPublicUrl(record.profileUrl) } : {}),
      ...(readStoredString(record.reportedPhone, 80) ? { reportedPhone: readStoredString(record.reportedPhone, 80) } : {}),
      ...(readStoredString(record.reportedEmail, 240) ? { reportedEmail: readStoredString(record.reportedEmail, 240) } : {}),
      sourceUrls,
      ...(sourceTitles?.length ? { sourceTitles } : {}),
      ...(readStoredString(record.evidence, 2_000) ? { evidence: readStoredString(record.evidence, 2_000) } : {}),
      ...(relatedLeadIds?.length ? { relatedLeadIds } : {}),
      discoveredAt,
    } satisfies ReviewCandidate];
  });

  return [...new Map(normalized.map((candidate) => [candidate.id, candidate])).values()].slice(0, 200);
};

const sanitizeJob = (job: SearchJobRecord): SearchJobRecord => {
  const currentTime = nowMs();

  if (!isValidSearchId(job.searchId)) {
    throw new Error(`Invalid search id: ${job.searchId}`);
  }

  return {
    ...job,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    searchId: normalizeSearchId(job.searchId),
    ownerId:
      typeof job.ownerId === 'string' && job.ownerId.trim() && job.ownerId.trim().length <= 256
        ? job.ownerId.trim()
        : undefined,
    idempotencyKey:
      typeof job.idempotencyKey === 'string' && job.idempotencyKey.trim()
        ? job.idempotencyKey.trim()
        : undefined,
    requestFingerprint:
      typeof job.requestFingerprint === 'string' && job.requestFingerprint.trim()
        ? job.requestFingerprint.trim()
        : undefined,
    request: {
      ...job.request,
      sourceMode: normalizeLeadSourceMode(job.request?.sourceMode),
      ...(normalizeCallbackRequest(job.request?.callback)
        ? { callback: normalizeCallbackRequest(job.request.callback) }
        : { callback: undefined }),
    },
    callback: sanitizeCallbackState(job.callback),
    query: job.query?.trim() ?? '',
    locationLabel: job.locationLabel?.trim() ?? '',
    locationMode: normalizeLocationMode(job.locationMode),
    progress: clampProgress(job.progress),
    leads: deduplicateLeads(normalizeStoredLeads(job.leads)),
    researchCandidates: normalizeStoredResearchCandidates(job.researchCandidates),
    reviewCandidates: normalizeStoredReviewCandidates(job.reviewCandidates),
    aiWorkflow: normalizeAiWorkflow(job.aiWorkflow),
    providerWarnings: dedupeWarnings(
      Array.isArray(job.providerWarnings) ? job.providerWarnings : [],
    ),
    searchSeeds: uniqueStrings(Array.isArray(job.searchSeeds) ? job.searchSeeds : []),
    nextSeedIndex: Math.min(
      uniqueStrings(Array.isArray(job.searchSeeds) ? job.searchSeeds : []).length,
      Math.max(0, Math.floor(Number(job.nextSeedIndex ?? 0))),
    ),
    enrichmentQueue: Array.isArray(job.enrichmentQueue)
      ? uniqueStrings(job.enrichmentQueue)
      : undefined,
    enrichmentCursor: Number.isFinite(job.enrichmentCursor)
      ? Math.max(0, Math.floor(job.enrichmentCursor as number))
      : undefined,
    discoveryComplete: Boolean(job.discoveryComplete),
    lastProgressAt: Number.isFinite(job.lastProgressAt)
      ? job.lastProgressAt
      : currentTime,
    createdAt: Number.isFinite(job.createdAt)
      ? job.createdAt
      : currentTime,
    updatedAt: currentTime,
    processingToken:
      typeof job.processingToken === 'string' && job.processingToken.trim()
        ? job.processingToken.trim()
        : undefined,
    processingUntil: Number.isFinite(job.processingUntil)
      ? job.processingUntil
      : undefined,
    cancelRequested:
      typeof job.cancelRequested === 'boolean' ? job.cancelRequested : undefined,
    expiresAt: Number.isFinite(job.expiresAt)
      ? job.expiresAt
      : currentTime + DEFAULT_JOB_TTL_MS,
  };
};

const migrateJobPayload = (payload: unknown): SearchJobRecord | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const raw = payload as Partial<SearchJobRecord>;

  if (!raw.searchId || !raw.request || !raw.status || !raw.progress) {
    return null;
  }

  return sanitizeJob({
    schemaVersion: Number(raw.schemaVersion ?? 1),
    searchId: String(raw.searchId),
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : undefined,
    idempotencyKey:
      typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : undefined,
    requestFingerprint:
      typeof raw.requestFingerprint === 'string' ? raw.requestFingerprint : undefined,
    request: raw.request,
    callback: sanitizeCallbackState(raw.callback),
    query: String(raw.query ?? ''),
    locationLabel: String(raw.locationLabel ?? ''),
    locationMode: normalizeLocationMode(raw.locationMode),
    status: raw.status,
    progress: raw.progress,
    leads: Array.isArray(raw.leads) ? raw.leads : [],
    researchCandidates: Array.isArray(raw.researchCandidates) ? raw.researchCandidates : [],
    reviewCandidates: Array.isArray(raw.reviewCandidates) ? raw.reviewCandidates : [],
    aiWorkflow: normalizeAiWorkflow(raw.aiWorkflow),
    providerWarnings: Array.isArray(raw.providerWarnings)
      ? raw.providerWarnings
      : [],
    searchSeeds: Array.isArray(raw.searchSeeds) ? raw.searchSeeds : [],
    nextSeedIndex: Number(raw.nextSeedIndex ?? 0),
    enrichmentQueue: Array.isArray(raw.enrichmentQueue) ? raw.enrichmentQueue : undefined,
    enrichmentCursor: Number(raw.enrichmentCursor ?? 0),
    discoveryComplete: Boolean(raw.discoveryComplete),
    googleMapsUnavailable: Boolean(raw.googleMapsUnavailable),
    lastProgressAt: Number(raw.lastProgressAt ?? nowMs()),
    expiresAt: Number(raw.expiresAt ?? nowMs() + DEFAULT_JOB_TTL_MS),
    createdAt: Number(raw.createdAt ?? nowMs()),
    updatedAt: Number(raw.updatedAt ?? nowMs()),
    processingToken:
      typeof raw.processingToken === 'string' ? raw.processingToken : undefined,
    processingUntil: Number.isFinite(raw.processingUntil)
      ? raw.processingUntil
      : undefined,
    cancelRequested:
      typeof raw.cancelRequested === 'boolean' ? raw.cancelRequested : undefined,
  });
};

const parsePayload = (payload: SearchJobRecord | string | unknown) => {
  try {
    const parsed =
      typeof payload === 'string'
        ? JSON.parse(payload)
        : payload;

    return migrateJobPayload(parsed);
  } catch {
    return null;
  }
};

const unavailableStore = (message: string): SearchJobStore => {
  const fail = async (): Promise<never> => {
    throw new SearchPersistenceError(message);
  };

  return {
    ensureSchema: fail,
    get: fail,
    create: fail,
    getByIdempotencyKey: fail,
    claim: fail,
    upsert: fail,
    requestCancel: fail,
    deleteExpired: fail,
  };
};

const memoryStore = (): SearchJobStore => {
  const jobs = new Map<string, SearchJobRecord>();

  const prune = (now: number) => {
    for (const [searchId, job] of jobs.entries()) {
      if (job.expiresAt <= now) {
        jobs.delete(searchId);
      }
    }

    if (jobs.size <= MEMORY_MAX_JOBS) {
      return;
    }

    const oldest = [...jobs.entries()]
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
      .slice(0, jobs.size - MEMORY_MAX_JOBS);

    for (const [searchId] of oldest) {
      jobs.delete(searchId);
    }
  };

  return {
    ensureSchema: async () => undefined,

    get: async (searchId: string, ownerId?: string) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      const job = jobs.get(normalized);
      if (!job || (ownerId && job.ownerId !== ownerId)) return null;

      return job;
    },

    create: async (job: SearchJobRecord) => {
      const sanitized = sanitizeJob(job);
      const existingByKey = sanitized.idempotencyKey
        ? [...jobs.values()].find(
            (candidate) => candidate.idempotencyKey === sanitized.idempotencyKey,
          )
        : undefined;
      const existing = existingByKey ?? jobs.get(sanitized.searchId);

      if (existing) {
        if (existing.ownerId !== sanitized.ownerId) {
          throw new SearchIdempotencyConflictError();
        }

        if (
          sanitized.idempotencyKey &&
          existing.requestFingerprint !== sanitized.requestFingerprint
        ) {
          throw new SearchIdempotencyConflictError();
        }

        return { job: existing, created: false };
      }

      jobs.set(sanitized.searchId, sanitized);
      if (jobs.size > MEMORY_MAX_JOBS) {
        const oldest = [...jobs.entries()]
          .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
          .slice(0, jobs.size - MEMORY_MAX_JOBS);

        for (const [searchId] of oldest) {
          jobs.delete(searchId);
        }
      }

      return { job: sanitized, created: true };
    },

    getByIdempotencyKey: async (
      idempotencyKey: string,
      requestFingerprint: string,
      now: number,
      ownerId?: string,
    ) => {
      prune(now);
      const job = [...jobs.values()].find(
        (candidate) =>
          candidate.idempotencyKey === idempotencyKey &&
          candidate.expiresAt > now &&
          (ownerId ? candidate.ownerId === ownerId : !candidate.ownerId),
      );
      if (!job || (ownerId && job.ownerId !== ownerId)) {
        return null;
      }

      if (job.requestFingerprint !== requestFingerprint) {
        throw new SearchIdempotencyConflictError();
      }

      return job;
    },

    claim: async (
      searchId: string,
      now: number,
      leaseMs: number,
      token: string,
      ownerId?: string,
    ) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      const job = jobs.get(normalized);
      const active = job ? ['queued', 'discovering', 'enriching'].includes(job.status) : false;
      const callbackReady = Boolean(job) && !active && isCallbackDue(job?.callback, now);
      if (
        !job ||
        (ownerId && job.ownerId !== ownerId) ||
        (job.cancelRequested && !callbackReady) ||
        (!active && !callbackReady) ||
        (job.processingUntil ?? 0) > now
      ) {
        return null;
      }

      const claimed = {
        ...job,
        processingToken: token,
        processingUntil: now + leaseMs,
        updatedAt: now,
      };
      jobs.set(normalized, claimed);
      return claimed;
    },

    upsert: async (job: SearchJobRecord) => {
      const sanitized = sanitizeJob(job);
      const existing = jobs.get(sanitized.searchId);
      const cancelledDuringWork =
        existing?.cancelRequested === true &&
        sanitized.cancelRequested !== false &&
        sanitized.status !== 'cancelled';
      jobs.set(
        sanitized.searchId,
        cancelledDuringWork
          ? {
              ...sanitized,
              cancelRequested: true,
              status: 'cancelled',
              progress: { ...sanitized.progress, currentSource: 'Cancelled' },
            }
          : sanitized,
      );

      if (jobs.size > MEMORY_MAX_JOBS) {
        const oldest = [...jobs.entries()]
          .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
          .slice(0, jobs.size - MEMORY_MAX_JOBS);

        for (const [searchId] of oldest) {
          jobs.delete(searchId);
        }
      }
    },

    requestCancel: async (searchId: string, now: number, ownerId?: string) => {
      const normalized = normalizeSearchId(searchId);
      const job = jobs.get(normalized);

      if (
        !job ||
        (ownerId && job.ownerId !== ownerId) ||
        ['complete', 'failed', 'cancelled'].includes(job.status)
      ) {
        return job ?? null;
      }

      const cancelled = sanitizeJob({
        ...job,
        cancelRequested: true,
        status: 'cancelled',
        updatedAt: now,
        progress: { ...job.progress, currentSource: 'Cancelled' },
      });
      jobs.set(normalized, cancelled);
      return cancelled;
    },

    deleteExpired: async (now: number) => {
      prune(now);
    },
  };
};

const isHiddenWarning = (warning: ProviderWarning) =>
  warning.providerId === 'website-crawl' &&
  /blocked contact crawling|timed out during contact crawling/i.test(warning.message);

const toCallbackContract = (callback: SearchCallbackState): SearchCallbackContract => ({
  configured: true,
  eventId: callback.eventId,
  status: callback.status,
  attempts: callback.attempts,
  ...(callback.lastAttemptAt
    ? { lastAttemptAt: new Date(callback.lastAttemptAt).toISOString() }
    : {}),
  ...(callback.nextAttemptAt
    ? { nextAttemptAt: new Date(callback.nextAttemptAt).toISOString() }
    : {}),
  ...(callback.lastStatusCode ? { lastStatusCode: callback.lastStatusCode } : {}),
  ...(callback.deliveredAt
    ? { deliveredAt: new Date(callback.deliveredAt).toISOString() }
    : {}),
});

const postgresStore = (): SearchJobStore => {
  let schemaReady = false;
  let schemaPromise: Promise<void> | null = null;

  const ensureSchema = async () => {
    if (schemaReady) {
      return;
    }

    if (schemaPromise) {
      return schemaPromise;
    }

    schemaPromise = (async () => {
      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      // Keep cold-start schema setup to one database round-trip. Snapshot reads
      // share the same serverless invocation budget as provider discovery.
      await client.query(`
        create table if not exists lead_finder_jobs (
          search_id text primary key,
          payload jsonb not null,
          expires_at bigint not null,
          created_at bigint not null,
          updated_at bigint not null
        );
        create index if not exists lead_finder_jobs_expires_at_idx
          on lead_finder_jobs (expires_at);
        create index if not exists lead_finder_jobs_updated_at_idx
          on lead_finder_jobs (updated_at);
        create unique index if not exists lead_finder_jobs_idempotency_unique_idx
          on lead_finder_jobs ((payload->>'idempotencyKey'))
          where payload ? 'idempotencyKey';
      `);

      schemaReady = true;
    })();

    try {
      await schemaPromise;
    } finally {
      schemaPromise = null;
    }
  };

  return {
    ensureSchema,

    get: async (searchId: string, ownerId?: string) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const result = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          select payload
          from lead_finder_jobs
          where search_id = $1
            and expires_at > $2
            and ($3::text is null or payload->>'ownerId' = $3)
          limit 1
        `,
        [normalized, nowMs(), ownerId ?? null],
      );

      const payload = result.rows[0]?.payload;

      if (!payload) {
        return null;
      }

      return parsePayload(payload);
    },

    create: async (job: SearchJobRecord) => {
      const sanitized = sanitizeJob(job);

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const inserted = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          insert into lead_finder_jobs (
            search_id,
            payload,
            expires_at,
            created_at,
            updated_at
          ) values (
            $1,
            $2::jsonb,
            $3,
            $4,
            $5
          )
          on conflict do nothing
          returning payload
        `,
        [
          sanitized.searchId,
          JSON.stringify(sanitized),
          sanitized.expiresAt,
          sanitized.createdAt,
          sanitized.updatedAt,
        ],
      );

      const insertedJob = parsePayload(inserted.rows[0]?.payload);
      if (insertedJob) {
        return { job: insertedJob, created: true };
      }

      const existingResult = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          select payload
          from lead_finder_jobs
          where search_id = $1
             or (
               payload->>'idempotencyKey' = $2
               and expires_at > $3
             )
          order by case when search_id = $1 then 0 else 1 end, updated_at desc
          limit 1
        `,
        [sanitized.searchId, sanitized.idempotencyKey ?? '', nowMs()],
      );
      const existingJob = parsePayload(existingResult.rows[0]?.payload);

      if (!existingJob) {
        throw new Error('Search job could not be created or recovered.');
      }

      if (existingJob.ownerId !== sanitized.ownerId) {
        throw new SearchIdempotencyConflictError();
      }

      if (
        sanitized.idempotencyKey &&
        existingJob.idempotencyKey === sanitized.idempotencyKey &&
        existingJob.requestFingerprint !== sanitized.requestFingerprint
      ) {
        throw new SearchIdempotencyConflictError();
      }

      return { job: existingJob, created: false };
    },

    getByIdempotencyKey: async (
      idempotencyKey: string,
      requestFingerprint: string,
      now: number,
      ownerId?: string,
    ) => {
      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const result = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          select payload
          from lead_finder_jobs
          where payload->>'idempotencyKey' = $1
            and expires_at > $2
            and (
              ($3::text is null and not (payload ? 'ownerId'))
              or payload->>'ownerId' = $3
            )
          order by updated_at desc
          limit 1
        `,
        [idempotencyKey, now, ownerId ?? null],
      );

      const job = parsePayload(result.rows[0]?.payload);
      if (!job) {
        return null;
      }

      if (job.requestFingerprint !== requestFingerprint) {
        throw new SearchIdempotencyConflictError();
      }

      return job;
    },

    claim: async (
      searchId: string,
      now: number,
      leaseMs: number,
      token: string,
      ownerId?: string,
    ) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const leaseUntil = now + leaseMs;
      const result = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          update lead_finder_jobs
          set payload = jsonb_set(
            jsonb_set(payload, '{processingToken}', to_jsonb($3::text), true),
            '{processingUntil}', to_jsonb($2::bigint), true
          ),
          updated_at = $4
          where search_id = $1
            and expires_at > $4
            and coalesce(
              case
                when payload->>'processingUntil' ~ '^[0-9]+$'
                  then (payload->>'processingUntil')::bigint
                else 0
              end,
              0
            ) <= $4
            and (
              coalesce(payload->>'status', '') in ('queued', 'discovering', 'enriching')
              or (
                coalesce(payload->>'status', '') in ('complete', 'failed', 'cancelled')
                and payload->'callback'->>'status' in ('pending', 'retrying')
                and coalesce(
                  case
                    when payload->'callback'->>'nextAttemptAt' ~ '^[0-9]+$'
                      then (payload->'callback'->>'nextAttemptAt')::bigint
                    else 0
                  end,
                  0
                ) <= $4
              )
            )
            and (
              coalesce(payload->>'cancelRequested', 'false') <> 'true'
              or (
                coalesce(payload->>'status', '') in ('complete', 'failed', 'cancelled')
                and payload->'callback'->>'status' in ('pending', 'retrying')
              )
            )
            and ($5::text is null or payload->>'ownerId' = $5)
          returning payload
        `,
        [normalized, leaseUntil, token, now, ownerId ?? null],
      );

      return parsePayload(result.rows[0]?.payload);
    },

    upsert: async (job: SearchJobRecord) => {
      const sanitized = sanitizeJob(job);

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const persistedResult = await client.query<{
        payload: SearchJobRecord | string;
      }>(
        `
          insert into lead_finder_jobs (
            search_id,
            payload,
            expires_at,
            created_at,
            updated_at
          ) values (
            $1,
            $2::jsonb,
            $3,
            $4,
            $5
          )
          on conflict (search_id) do update set
            payload = case
              when lead_finder_jobs.payload->>'cancelRequested' = 'true'
                and excluded.payload->>'cancelRequested' is distinct from 'false'
                and excluded.payload->>'status' <> 'cancelled'
                then jsonb_set(
                  jsonb_set(
                    jsonb_set(excluded.payload, '{cancelRequested}', 'true'::jsonb, true),
                    '{status}', '"cancelled"'::jsonb, true
                  ),
                  '{progress,currentSource}', '"Cancelled"'::jsonb, true
                )
              else excluded.payload
            end,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
          returning payload
        `,
        [
          sanitized.searchId,
          JSON.stringify(sanitized),
          sanitized.expiresAt,
          sanitized.createdAt,
          sanitized.updatedAt,
        ],
      );

      const persistedJob = parsePayload(persistedResult.rows[0]?.payload);
      if (persistedJob && ['complete', 'failed', 'cancelled'].includes(persistedJob.status)) {
        try {
          await persistNormalizedResearch(client, persistedJob);
        } catch (error) {
          console.error('[search-job-store] normalized research persistence skipped', error);
        }
      }
    },

    requestCancel: async (searchId: string, now: number, ownerId?: string) => {
      const normalized = normalizeSearchId(searchId);

      if (!isValidSearchId(normalized)) {
        return null;
      }

      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      const result = await client.query<{ payload: SearchJobRecord | string }>(
        `
          update lead_finder_jobs
          set payload = jsonb_set(
            jsonb_set(
              jsonb_set(payload, '{cancelRequested}', 'true'::jsonb, true),
              '{status}', '"cancelled"'::jsonb, true
            ),
            '{progress,currentSource}', '"Cancelled"'::jsonb, true
          ),
          updated_at = $2
          where search_id = $1
            and expires_at > $2
            and coalesce(payload->>'status', '') in ('queued', 'discovering', 'enriching')
            and ($3::text is null or payload->>'ownerId' = $3)
          returning payload
        `,
        [normalized, now, ownerId ?? null],
      );

      return parsePayload(result.rows[0]?.payload);
    },

    deleteExpired: async (now: number) => {
      await ensureSchema();

      const client = getPool();

      if (!client) {
        throw new Error('Missing Postgres connection string');
      }

      await client.query(
        `
          delete from lead_finder_jobs
          where expires_at <= $1
        `,
        [now],
      );
    },

    close: async () => {
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  };
};

export const createSearchJobStore = (): SearchJobStore => {
  const fallback = memoryStore();

  if (!connectionString) {
    if (isVercelRuntime) {
      return unavailableStore(
        'Search persistence is not configured. Add a Postgres connection string to the Vercel project before running searches.',
      );
    }

    return fallback;
  }

  const postgres = postgresStore();

  const withFallback = async <T>(
    operation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    label: string,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SearchIdempotencyConflictError) {
        throw error;
      }

      if (isVercelRuntime) {
        console.error(`[search-job-store] postgres ${label} failed`, error);
        throw new SearchPersistenceError(
          `Search persistence is unavailable while ${label}. Check the Vercel Postgres connection settings and try again.`,
        );
      }

      console.error(`[search-job-store] postgres ${label} failed; using memory fallback`, error);
      return fallbackOperation();
    }
  };

  return {
    ensureSchema: async () => {
      await withFallback(
        () => postgres.ensureSchema(),
        () => fallback.ensureSchema(),
        'ensureSchema',
      );
    },

    get: async (searchId: string, ownerId?: string) => {
      return withFallback(
        () => postgres.get(searchId, ownerId),
        () => fallback.get(searchId, ownerId),
        'get',
      );
    },

    create: async (job: SearchJobRecord) => {
      return withFallback(
        () => postgres.create(job),
        () => fallback.create(job),
        'create',
      );
    },

    getByIdempotencyKey: async (
      idempotencyKey: string,
      requestFingerprint: string,
      now: number,
      ownerId?: string,
    ) => {
      return withFallback(
        () => postgres.getByIdempotencyKey(idempotencyKey, requestFingerprint, now, ownerId),
        () => fallback.getByIdempotencyKey(idempotencyKey, requestFingerprint, now, ownerId),
        'getByIdempotencyKey',
      );
    },

    claim: async (
      searchId: string,
      now: number,
      leaseMs: number,
      token: string,
      ownerId?: string,
    ) => {
      return withFallback(
        () => postgres.claim(searchId, now, leaseMs, token, ownerId),
        () => fallback.claim(searchId, now, leaseMs, token, ownerId),
        'claim',
      );
    },

    upsert: async (job: SearchJobRecord) => {
      await withFallback(
        () => postgres.upsert(job),
        () => fallback.upsert(job),
        'upsert',
      );
    },

    requestCancel: async (searchId: string, now: number, ownerId?: string) => {
      return withFallback(
        () => postgres.requestCancel(searchId, now, ownerId),
        () => fallback.requestCancel(searchId, now, ownerId),
        'requestCancel',
      );
    },

    deleteExpired: async (now: number) => {
      await withFallback(
        () => postgres.deleteExpired(now),
        () => fallback.deleteExpired(now),
        'deleteExpired',
      );
    },

    close: async () => {
      await postgres.close?.();
    },
  };
};

const countLeadTotals = (leads: Lead[]) => {
  const uniqueLeads = deduplicateLeads(leads);

  return {
    total: uniqueLeads.length,
    withEmail: uniqueLeads.filter((lead) => lead.hasEmail).length,
    withPhone: uniqueLeads.filter((lead) => lead.hasPhone).length,
    withWebsite: uniqueLeads.filter((lead) => lead.hasWebsite).length,
  };
};

export const toSearchResponse = (
  job: SearchJobRecord,
  suppressionKeys: ReadonlySet<string> = new Set(),
): SearchResponse => {
  const qualification = enforcePhoneRequirement(
    deduplicateLeads(normalizeStoredLeads(job.leads)),
    job.request,
  );
  const suppression = filterSuppressedLeads(qualification.leads, suppressionKeys);
  const leads = suppression.leads.slice(0, job.request.count);
  const emptyCompletion = job.status === 'complete' && !leads.length && !suppression.suppressedCount;
  const contract = buildSearchResponseContract(normalizeLeadSourceMode(job.request.sourceMode));
  const status = emptyCompletion ? 'failed' : job.status;
  const lastProgressAt = new Date(job.lastProgressAt).toISOString();
  const completedAt = ['complete', 'failed', 'cancelled'].includes(status)
    ? lastProgressAt
    : undefined;
  const providerWarnings = dedupeWarnings([
    ...job.providerWarnings,
    ...(qualification.warning ? [qualification.warning] : []),
    ...(suppression.suppressedCount
      ? [{
          providerId: 'workspace-suppression',
          providerName: 'Workspace feedback',
          message: `${suppression.suppressedCount} lead(s) were hidden from this workspace after operator feedback.`,
          severity: 'info' as const,
        }]
      : []),
    ...(emptyCompletion ? [noUsableResultsWarning()] : []),
  ]).filter(
    (warning) => !isHiddenWarning(warning),
  );
  const progress = {
    ...job.progress,
    foundCount: leads.length,
    phoneExcludedCount: Math.max(job.progress.phoneExcludedCount ?? 0, qualification.excludedCount),
    suppressedCount: Math.max(job.progress.suppressedCount ?? 0, suppression.suppressedCount),
    currentSource: emptyCompletion ? 'Failed' : job.progress.currentSource,
    estimatedRemaining: Math.max(0, job.request.count - leads.length),
  };

  return {
    ...contract,
    searchId: job.searchId,
    leads,
    ...(normalizeStoredResearchCandidates(job.researchCandidates).length
      ? { researchCandidates: normalizeStoredResearchCandidates(job.researchCandidates) }
      : {}),
    ...(normalizeStoredReviewCandidates(job.reviewCandidates).length
      ? { reviewCandidates: normalizeStoredReviewCandidates(job.reviewCandidates) }
      : {}),
    meta: {
      ...contract.meta,
      query: job.query,
      locationLabel: job.locationLabel,
      researchDepth: job.request.researchDepth ?? 'verified',
      researchBrief: job.request.researchBrief,
      status,
      execution: buildSearchExecutionContract({
        path: 'durable',
        startedAt: new Date(job.createdAt).toISOString(),
        lastProgressAt,
        ...(completedAt ? { completedAt } : {}),
      }),
      ...(job.callback ? { callback: toCallbackContract(job.callback) } : {}),
      qualitySummary: buildLeadQualitySummary(leads),
      progress,
      totals: countLeadTotals(leads),
      providerWarnings,
    },
  };
};

export const createSearchJobRecord = (
  params: Pick<
    SearchJobRecord,
    'searchId' | 'request' | 'query' | 'locationLabel' | 'locationMode' | 'progress'
  > &
    Partial<
      Pick<
        SearchJobRecord,
        | 'ownerId'
        | 'idempotencyKey'
        | 'requestFingerprint'
        | 'callback'
        | 'status'
        | 'leads'
        | 'researchCandidates'
        | 'reviewCandidates'
        | 'aiWorkflow'
        | 'providerWarnings'
        | 'searchSeeds'
        | 'nextSeedIndex'
        | 'discoveryComplete'
        | 'expiresAt'
      >
    >,
): SearchJobRecord => {
  const now = nowMs();

  return sanitizeJob({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    searchId: params.searchId,
    ownerId: params.ownerId,
    idempotencyKey: params.idempotencyKey,
    requestFingerprint: params.requestFingerprint,
    request: params.request,
    callback: params.callback,
    query: params.query,
    locationLabel: params.locationLabel,
    locationMode: params.locationMode,
    status: params.status ?? 'queued',
    progress: params.progress,
    leads: params.leads ?? [],
    researchCandidates: params.researchCandidates ?? [],
    reviewCandidates: params.reviewCandidates ?? [],
    aiWorkflow: params.aiWorkflow,
    providerWarnings: params.providerWarnings ?? [],
    searchSeeds: params.searchSeeds ?? [],
    nextSeedIndex: params.nextSeedIndex ?? 0,
    discoveryComplete: params.discoveryComplete ?? false,
    lastProgressAt: now,
    expiresAt: params.expiresAt ?? now + DEFAULT_JOB_TTL_MS,
    createdAt: now,
    updatedAt: now,
  });
};
