import { z } from 'zod';

import type { Lead } from './lead';

const searchSourceModes = ['gmb', 'linkedin'] as const;

export const searchRequestSchema = z.object({
  companyType: z.string().trim().min(2).max(80),
  sourceMode: z.enum(searchSourceModes).optional(),
  city: z.string().trim().min(2).max(80),
  count: z.number().int().min(50).max(500),
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
