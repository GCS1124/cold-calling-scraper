import { z } from 'zod';

import type { Lead } from './lead';

const searchSourceModes = ['gmb', 'linkedin', 'ai'] as const;

export const searchRequestSchema = z.object({
  companyType: z.string().trim().min(2).max(80),
  sourceMode: z.enum(searchSourceModes).optional(),
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

export type ProviderWarning = {
  providerId: string;
  providerName: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
};

export type ProviderCoverage = {
  providerId: string;
  providerName: string;
  status: 'configured' | 'not_configured' | 'returned' | 'failed';
  leadCount: number;
  message?: string;
};

export type SearchStatus =
  | 'queued'
  | 'discovering'
  | 'enriching'
  | 'complete'
  | 'failed';

export type SearchProgress = {
  discovered: number;
  enriched: number;
  /** Count of leads with a validated public email or phone number. */
  publicContactsFound?: number;
  /** Number of public LinkedIn query paths attempted during discovery. */
  publicQueriesAttempted?: number;
  /** Number of free public search sources contacted during discovery. */
  publicProvidersChecked?: number;
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
  searchId: string;
  leads: Lead[];
  meta: {
    query: string;
    locationLabel: string;
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
