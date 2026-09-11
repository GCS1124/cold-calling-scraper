import { z } from 'zod';

import type { Lead, ResearchCandidate, ReviewCandidate } from './lead';
import type { LeadFeedbackEventType } from '../../../shared/lead-feedback';
import type { LeadQualitySummary } from '../../../shared/lead-quality';
import type {
  SearchExecutionContract,
  SearchCallbackContract,
  PhonePolicyContract,
  SearchModeCode,
  SEARCH_RESPONSE_CONTRACT_VERSION,
} from '../../../shared/search-contract';

const searchSourceModes = ['gmb', 'ai'] as const;

export const researchDepths = ['quick', 'verified', 'pro'] as const;
export type ResearchDepth = (typeof researchDepths)[number];

export const searchRequestSchema = z.object({
  companyType: z.string().trim().min(2).max(80),
  sourceMode: z.enum(searchSourceModes).optional(),
  researchDepth: z.enum(researchDepths).optional(),
  researchBrief: z.string().trim().max(1_000).optional(),
  city: z.string().trim().min(2).max(80),
  count: z.number().int().min(50).max(500),
  phoneRequired: z.literal(true).optional(),
  callback: z
    .object({
      url: z.string().trim().min(1).max(2_048),
    })
    .strict()
    .optional(),
  filters: z
    .object({
      hasEmail: z.boolean().optional(),
      hasPhone: z.boolean().optional(),
      hasWebsite: z.boolean().optional(),
      sources: z.array(z.string()).optional(),
    })
    .optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export type SearchStartContext = {
  idempotencyKey?: string;
  /** Supabase auth user id used to isolate durable search jobs. */
  ownerId?: string;
};

export type SearchFeedbackRequest = {
  leadId: string;
  eventType: LeadFeedbackEventType;
  reason?: string;
};

export type SearchAccessContext = {
  /** Supabase auth user id used to authorize durable search reads and writes. */
  ownerId?: string;
};

export type ProviderWarning = {
  providerId: string;
  providerName: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
};

/** Lifecycle state is separate from the legacy coarse status for compatibility. */
export type ProviderCoveragePhase =
  | 'queued'
  | 'running'
  | 'completed'
  | 'degraded'
  | 'skipped';

/** The concrete result of a provider attempt or bounded provider stage. */
export type ProviderCoverageOutcome =
  | 'not_started'
  | 'returned'
  | 'empty'
  | 'timed_out'
  | 'blocked'
  | 'rate_limited'
  | 'failed'
  | 'filtered'
  | 'deferred'
  | 'not_configured';

export type ProviderCoverage = {
  providerId: string;
  providerName: string;
  /** Legacy coarse state retained for existing API consumers. */
  status: 'configured' | 'not_configured' | 'returned' | 'failed' | 'partial';
  /** Backward-compatible alias for the records accepted by this provider. */
  leadCount: number;
  phase?: ProviderCoveragePhase;
  outcome?: ProviderCoverageOutcome;
  /** Provider requests/search paths started inside this bounded stage. */
  attemptedCount?: number;
  /** Raw public candidates parsed before location, category, or phone gating. */
  observedCount?: number;
  /** Candidates accepted into the shared lead pool before final export gating. */
  acceptedCount?: number;
  /** Useful public candidates held in the review queue. */
  reviewCount?: number;
  /** Work intentionally left for a later durable tick. */
  deferredCount?: number;
  /** Completed public checks, primarily used by website enrichment. */
  completedCount?: number;
  /** Records that gained verified public contact or decision-maker evidence. */
  enrichedCount?: number;
  /** Public checks stopped by an explicit access denial without any bypass. */
  blockedCount?: number;
  /** Public checks that exceeded their bounded window. */
  timedOutCount?: number;
  /** Duplicate or ineligible work intentionally not re-run in this stage. */
  skippedCount?: number;
  /** Public decision-maker names recovered from a business website. */
  decisionMakerRecoveredCount?: number;
  /** ISO timestamp for the newest observation; omitted on legacy snapshots. */
  updatedAt?: string;
  message?: string;
};

export type SearchStatus =
  | 'queued'
  | 'discovering'
  | 'enriching'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type SearchProgress = {
  discovered: number;
  enriched: number;
  /** Count of leads with a validated public email or phone number. */
  publicContactsFound?: number;
  /** Number of discovered candidates removed by the mandatory phone gate. */
  phoneExcludedCount?: number;
  /** Number of owner-suppressed leads removed after phone qualification. */
  suppressedCount?: number;
  /** Number of public LinkedIn query paths attempted during discovery. */
  publicQueriesAttempted?: number;
  /** Number of free public search sources contacted during discovery. */
  publicProvidersChecked?: number;
  /** Public LinkedIn discovery lenses that completed at least one query batch. */
  publicQueryFamilies?: string[];
  /** Number of public LinkedIn query paths attempted per discovery lens. */
  publicQueryFamilyCounts?: Record<string, number>;
  /** Status of each provider involved in AI mode discovery. */
  providerCoverage?: ProviderCoverage[];
  /** Whether Gemini public search assistance ran. A configured key enables it unless disabled. */
  aiAssistance?: 'enabled' | 'disabled' | 'failed' | 'rate_limited';
  totalCandidates: number;
  requestedCount: number;
  foundCount: number;
  duplicatesRemoved: number;
  currentSource: string;
  batchesCompleted: number;
  estimatedRemaining: number;
};

export type SearchResponse = {
  /** Optional for compatibility with legacy synthetic fixtures; runtime responses include it. */
  contractVersion?: typeof SEARCH_RESPONSE_CONTRACT_VERSION;
  searchId: string;
  leads: Lead[];
  /** Model-discovered public references retained for review even when they do not pass phone validation. */
  researchCandidates?: ResearchCandidate[];
  /** Provider-neutral public candidates retained for review, never for automatic export. */
  reviewCandidates?: ReviewCandidate[];
  meta: {
    /** Optional for compatibility with legacy snapshots; runtime responses include it. */
    sourceMode?: SearchModeCode;
    /** Optional for compatibility with legacy snapshots; runtime responses include it. */
    execution?: SearchExecutionContract;
    callback?: SearchCallbackContract;
    /** HTTP request correlation id; omitted by non-HTTP service callers. */
    requestId?: string;
    qualitySummary?: LeadQualitySummary;
    phonePolicy?: PhonePolicyContract;
    limitations?: string[];
    query: string;
    locationLabel: string;
    researchDepth?: ResearchDepth;
    researchBrief?: string;
    status: SearchStatus;
    progress: SearchProgress;
    totals: {
      total: number;
      withEmail: number;
      withPhone: number;
      withWebsite: number;
    };
    providerWarnings: ProviderWarning[];
  };
};
