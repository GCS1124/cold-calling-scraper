import type { ProviderCoverage, ProviderWarning, SearchRequest } from '../types/search';
import {
  isGeminiQueryAssistanceEnabled,
} from '../providers/gemini';

export type GeminiQueryAssistanceResult = {
  queryHints: string[];
  aiAssistance: 'enabled' | 'disabled' | 'failed' | 'rate_limited';
  coverage: ProviderCoverage;
  warning?: ProviderWarning;
};

type GeminiQueryAssistanceDeps = {
  /**
   * Retained only so older internal callers keep type compatibility. It is
   * deliberately ignored: lead searches have exactly one grounded Gemini
   * request and deterministic lenses are folded into that request.
   */
  expandQuery?: unknown;
};

const initialCoverage = (): ProviderCoverage => {
  return {
    providerId: 'gemini-query-assistance',
    providerName: 'Deterministic search planning',
    status: 'returned',
    leadCount: 0,
    phase: 'completed',
    outcome: 'returned',
    attemptedCount: 0,
    observedCount: 0,
    acceptedCount: 0,
    reviewCount: 0,
    deferredCount: 0,
    message: 'Deterministic category, role, and concrete-location lenses are prepared without a separate Gemini request.',
  };
};

const addUniqueHints = (hints: string[]) =>
  [...new Set(hints.map((hint) => hint.trim()).filter(Boolean))].slice(0, 8);

export const runGeminiQueryAssistance = async ({
  seedHints = [],
}: {
  request: SearchRequest;
  locationLabel: string;
  seedHints?: string[];
  deadlineMs: number;
} & GeminiQueryAssistanceDeps): Promise<GeminiQueryAssistanceResult> => {
  const queryHints = addUniqueHints(seedHints);
  const geminiConfigured = isGeminiQueryAssistanceEnabled();

  return {
    queryHints,
    aiAssistance: geminiConfigured ? 'enabled' : 'disabled',
    coverage: {
      ...initialCoverage(),
      observedCount: queryHints.length,
      message: `Prepared ${queryHints.length} deterministic category, role, and location search lens${queryHints.length === 1 ? '' : 'es'} without a second Gemini request.`,
    },
  };
};
