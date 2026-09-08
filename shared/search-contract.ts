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

export type SearchModeCode = 'gmb' | 'linkedin' | 'ai';

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
  'A public business phone does not prove mobile line type, personal ownership, or reachability.',
  'Missing contact data means it was not publicly observed; it does not prove the business lacks it.',
] as const;

const modeLimitations: Record<SearchModeCode, readonly string[]> = {
  gmb: [
    'Google Business results depend on configured Google Places access; free public listing coverage is used as an independent fallback.',
  ],
  linkedin: [
    'LinkedIn discovery uses public search results only; private profiles, authenticated sessions, Premium data, and paywalls are not accessed.',
  ],
  ai: [
    'Gemini can expand public search lenses and return grounded public research candidates; public evidence and the required phone gate decide what becomes an exportable lead.',
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
