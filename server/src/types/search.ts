import { z } from 'zod';

import type { Lead } from './lead';
import type { LeadQualitySummary } from '../../../shared/lead-quality';
import type {
  SearchExecutionContract,
  PhonePolicyContract,
  SearchModeCode,
  SEARCH_RESPONSE_CONTRACT_VERSION,
} from '../../../shared/search-contract';

const searchSourceModes = ['gmb', 'linkedin', 'ai'] as const;

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

export type ProviderCoverage = {
  providerId: string;
  providerName: string;
  status: 'configured' | 'not_configured' | 'returned' | 'failed' | 'partial';
  leadCount: number;
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
  /** Whether an optional model-assisted query layer was used. Free mode keeps this disabled. */
  aiAssistance?: 'enabled' | 'disabled' | 'failed';
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
  meta: {
    /** Optional for compatibility with legacy snapshots; runtime responses include it. */
    sourceMode?: SearchModeCode;
    /** Optional for compatibility with legacy snapshots; runtime responses include it. */
    execution?: SearchExecutionContract;
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
