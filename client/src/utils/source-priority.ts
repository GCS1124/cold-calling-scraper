import type { Lead, ProviderCoverage } from '../types/lead';
import {
  getPublicLeadSourceOrder,
  getPublicLeadSourcePriority,
  getPublicProviderPriority,
  type PublicLeadSourceOrder,
  type PublicSourcePriority,
} from '../../../shared/source-priority';

export const isNotaryRelatedCategory = (value: unknown) =>
  typeof value === 'string' &&
  /\bnotar(?:y|ies)\b|\b(?:mobile|loan|signing|remote online|apostille)\s+notar(?:y|ies)\b|\bsigning\s+agent\b/i.test(
    value.trim(),
  );

/**
 * The AI workflow makes provenance stable and visible:
 * indexed NotaryCafe evidence, pure public LinkedIn evidence, Yelp, Yellow
 * Pages, generic public listings, Gemini, Google Business, website enrichment,
 * then LinkedIn plus Google Business fusion.
 * Eligibility still comes from the server's public-phone and evidence gates.
 */
export const getPublicSourcePriority = (lead: Lead): PublicSourcePriority => {
  return getPublicLeadSourcePriority(lead);
};

export const getPublicSourceOrder = (lead: Lead): PublicLeadSourceOrder => {
  return getPublicLeadSourceOrder(lead);
};

export const comparePublicSourcePriority = (left: Lead, right: Lead) =>
  getPublicSourceOrder(left) - getPublicSourceOrder(right);

export const publicSourcePriorityLabels: Record<PublicSourcePriority, string> = {
  1: 'NotaryCafe indexed evidence',
  2: 'Pure public LinkedIn evidence',
  3: 'Yelp public directory',
  4: 'Yellow Pages public directory',
  5: 'Generic public listings',
  6: 'Gemini public research',
  7: 'Google Business listings',
  8: 'Public website enrichment',
  9: 'LinkedIn + Google Business fusion',
};

export const publicLeadSourceOrderLabels: Record<PublicLeadSourceOrder, string> = {
  1: 'NotaryCafe indexed evidence',
  2: 'Pure public LinkedIn evidence',
  3: 'Yelp public directory',
  4: 'Yellow Pages public directory',
  5: 'Generic public listings',
  6: 'Gemini public research',
  7: 'Google Business listings',
  8: 'Public website enrichment',
  9: 'LinkedIn + Google Business fusion',
};

export const sortProviderCoverageForDisplay = (coverage: ProviderCoverage[]) =>
  coverage
    .map((provider, index) => ({
      provider,
      index,
      priority: getPublicProviderPriority(provider),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ provider }) => provider);
