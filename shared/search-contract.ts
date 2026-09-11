export const SEARCH_RESPONSE_CONTRACT_VERSION = 2 as const;
export const SEARCH_ERROR_CONTRACT_VERSION = 1 as const;

export type SearchApiErrorResponse = {
  error: string;
  code: string;
  retryable: boolean;
  requestId: string;
  contractVersion: typeof SEARCH_ERROR_CONTRACT_VERSION;
  details?: unknown;
};

/** The public product exposes two modes: GMB and AI public-source fusion. */
export type SearchModeCode = 'gmb' | 'ai';

export type SearchCallbackRequest = {
  url: string;
};

export type SearchCallbackStatus = 'pending' | 'retrying' | 'delivered' | 'failed';

export type SearchCallbackContract = {
  configured: true;
  eventId: string;
  status: SearchCallbackStatus;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastStatusCode?: number;
  deliveredAt?: string;
};

export type SearchExecutionContract =
  | {
      path: 'durable';
      pollable: true;
      resumable: true;
      startedAt: string;
      lastProgressAt: string;
      completedAt?: string;
    }
  | {
      path: 'stateless';
      pollable: false;
      resumable: false;
      startedAt: string;
      lastProgressAt: string;
      completedAt: string;
    };

type SearchExecutionInput = {
  path: SearchExecutionContract['path'];
  startedAt: string;
  lastProgressAt: string;
  completedAt?: string;
};

export const buildSearchExecutionContract = ({
  path,
  startedAt,
  lastProgressAt,
  completedAt,
}: SearchExecutionInput): SearchExecutionContract => {
  if (path === 'stateless') {
    return {
      path,
      pollable: false,
      resumable: false,
      startedAt,
      lastProgressAt,
      completedAt: completedAt ?? lastProgressAt,
    };
  }

  return {
    path,
    pollable: true,
    resumable: true,
    startedAt,
    lastProgressAt,
    ...(completedAt ? { completedAt } : {}),
  };
};

export type PhonePolicyContract = {
  required: true;
  evidence: 'public_phone_evidence';
  lineType: 'not_checked';
  reachability: 'not_checked';
  personalOwnership: 'not_checked';
  emailDelivery: 'not_checked';
};

const phonePolicy: PhonePolicyContract = {
  required: true,
  evidence: 'public_phone_evidence',
  lineType: 'not_checked',
  reachability: 'not_checked',
  personalOwnership: 'not_checked',
  emailDelivery: 'not_checked',
};

const commonLimitations = [
  'Only public, legally accessible sources are used.',
  'Public directory coverage includes bounded Yelp and Yellow Pages result-page checks; a block, CAPTCHA, Cloudflare challenge, or empty response is reported as partial coverage rather than bypassed.',
  'India-oriented directory adapters are intentionally excluded from US search modes; no location is silently widened to another country.',
  'A public business phone does not prove mobile line type, personal ownership, or reachability.',
  'Missing contact data means it was not publicly observed; it does not prove the business lacks it.',
] as const;

const modeLimitations: Record<SearchModeCode, readonly string[]> = {
  gmb: [
    'Google Business results depend on configured Google Places access; free public listing coverage and bounded public Yelp/Yellow Pages checks are used as independent fallbacks.',
  ],
  ai: [
    'AI mode fuses public business listings, bounded Yelp/Yellow Pages directory checks, public professional-profile discovery including LinkedIn result signals, search-indexed public NotaryCafe profile references, Gemini-grounded research, public websites, and published social links into one ranked evidence graph.',
    'AI lead display order is deterministic: indexed NotaryCafe, pure public LinkedIn, Yelp, Yellow Pages, generic public listings, Gemini public research, Google Business, public website enrichment, then LinkedIn plus Google Business fusion.',
    'Gemini receives one grounded public-research pass per search with at most 40 high-quality public listing seeds; public evidence and the required phone gate decide what becomes an exportable lead.',
    'NotaryCafe is checked as a bounded indexed-public cross-source probe on every AI search. A profile can qualify only when its indexed snippet explicitly supports the requested category and US location and exposes a public phone; references may be stale. Direct page access, login, CAPTCHA, Cloudflare, and geo-block bypasses are not used. Reverify before outreach.',
    'Commercial lead databases, paid contact lookups, private profiles, authenticated sessions, and contact-reveal credits are not called.',
  ],
};

export const buildSearchResponseContract = (sourceMode: SearchModeCode) => ({
  contractVersion: SEARCH_RESPONSE_CONTRACT_VERSION,
  meta: {
    sourceMode,
    phonePolicy,
    limitations: [...commonLimitations, ...modeLimitations[sourceMode]],
  },
});
