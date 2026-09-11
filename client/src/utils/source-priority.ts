import type { Lead, ProviderCoverage } from '../types/lead';
import {
  getPublicLeadSourcePriority,
  getPublicProviderPriority,
  type PublicSourcePriority,
} from '../../../shared/source-priority';

export const isNotaryRelatedCategory = (value: unknown) =>
  typeof value === 'string' &&
  /\bnotar(?:y|ies)\b|\b(?:mobile|loan|signing|remote online|apostille)\s+notar(?:y|ies)\b|\bsigning\s+agent\b/i.test(
    value.trim(),
  );

/**
 * The AI workflow makes provenance stable and visible:
 * indexed NotaryCafe evidence, pure public LinkedIn evidence, then generic
 * public evidence, with LinkedIn plus Google Business fusion last.
 * Eligibility still comes from the server's public-phone and evidence gates.
 */
export const getPublicSourcePriority = (lead: Lead): PublicSourcePriority => {
  return getPublicLeadSourcePriority(lead);
};

export const comparePublicSourcePriority = (left: Lead, right: Lead) =>
  getPublicSourcePriority(left) - getPublicSourcePriority(right);

export const publicSourcePriorityLabels: Record<PublicSourcePriority, string> = {
  1: 'NotaryCafe indexed evidence',
  2: 'Pure public LinkedIn evidence',
  3: 'Other public evidence',
  4: 'LinkedIn + Google Business fusion',
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
