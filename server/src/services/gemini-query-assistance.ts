import type { ProviderCoverage, ProviderWarning, SearchRequest } from '../types/search';
import {
  expandQueryWithGemini,
  getGeminiApiKeyCount,
  isGeminiRateLimitError,
  isGeminiQueryAssistanceEnabled,
  normalizeGeminiQueryHints,
} from '../providers/gemini';

export type GeminiQueryAssistanceResult = {
  queryHints: string[];
  aiAssistance: 'enabled' | 'disabled' | 'failed' | 'rate_limited';
  coverage: ProviderCoverage;
  warning?: ProviderWarning;
};

type GeminiQueryAssistanceDeps = {
  expandQuery?: typeof expandQueryWithGemini;
};

const queryAssistanceWindowMs = 5_500;

const withTimeout = async <T>(promise: Promise<T>, deadlineMs: number, message: string) => {
  const remainingMs = Math.max(1, deadlineMs - Date.now());
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const initialCoverage = (): ProviderCoverage => {
  const configured = isGeminiQueryAssistanceEnabled();
  const keyCount = getGeminiApiKeyCount();
  const keySummary = keyCount > 1
    ? `${keyCount} Gemini API keys are pooled and rotated across healthy requests.`
    : 'A Gemini API key is configured for public research.';

  return {
    providerId: 'gemini-query-assistance',
    providerName: 'Gemini search planning',
    status: configured ? 'configured' : 'not_configured',
    leadCount: 0,
    message: configured
      ? `${keySummary} Gemini expands multiple public search lenses; public sources and deterministic checks decide what becomes a lead.`
      : 'Gemini is not configured; deterministic local category and role expansion continues.',
  };
};

const addUniqueHints = (hints: string[]) =>
  [...new Set(hints.map((hint) => hint.trim()).filter(Boolean))].slice(0, 8);

export const runGeminiQueryAssistance = async ({
  request,
  locationLabel,
  seedHints = [],
  deadlineMs,
  expandQuery = expandQueryWithGemini,
}: {
  request: SearchRequest;
  locationLabel: string;
  seedHints?: string[];
  deadlineMs: number;
} & GeminiQueryAssistanceDeps): Promise<GeminiQueryAssistanceResult> => {
  const coverage = initialCoverage();
  const baseHints = addUniqueHints(seedHints);

  if (!isGeminiQueryAssistanceEnabled()) {
    return {
      queryHints: baseHints,
      aiAssistance: 'disabled',
      coverage,
    };
  }

  const rawQuery = `${request.companyType} in ${locationLabel}`;

  try {
    const assisted = await withTimeout(
      expandQuery(rawQuery, request),
      Math.min(deadlineMs, Date.now() + queryAssistanceWindowMs),
      'Gemini search planning timed out; deterministic public expansion continued.',
    );
    const generatedHints = normalizeGeminiQueryHints(assisted, []);
    const queryHints = addUniqueHints([...baseHints, ...generatedHints]).filter(
      (hint) => hint.toLowerCase() !== rawQuery.toLowerCase(),
    );

    return {
      queryHints,
      aiAssistance: 'enabled',
      coverage: {
        ...coverage,
        status: 'returned',
        message: `Gemini returned ${generatedHints.length} public search lens${generatedHints.length === 1 ? '' : 'es'}; public sources supplied and validated the results.`,
      },
    };
  } catch (error) {
    const rateLimited = isGeminiRateLimitError(error) ||
      (error instanceof Error && /429|rate.?limit|too many requests|quota/i.test(error.message));
    const message = rateLimited
      ? 'Gemini free-tier quota or rate limit was reached; deterministic public expansion continued.'
      : error instanceof Error
        ? `${error.message} Deterministic public expansion continued.`
        : 'Gemini search planning failed. Deterministic public expansion continued.';

    return {
      queryHints: baseHints,
      aiAssistance: rateLimited ? 'rate_limited' : 'failed',
      coverage: {
        ...coverage,
        status: rateLimited ? 'partial' : 'failed',
        message,
      },
      warning: {
        providerId: 'gemini-query-assistance',
        providerName: 'Gemini search planning',
        message,
        severity: 'warning',
      },
    };
  }
};
