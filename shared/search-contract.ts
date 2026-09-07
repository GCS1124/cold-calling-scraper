export const SEARCH_RESPONSE_CONTRACT_VERSION = 2 as const;

export type SearchModeCode = 'gmb' | 'linkedin' | 'ai';

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
    'AI assistance can rewrite search wording only; public providers supply the lead and contact facts.',
    'Commercial lead databases and paid contact lookups are not called.',
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
