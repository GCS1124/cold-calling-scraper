import type { Lead } from '../types/lead';

export const qualityLabels = {
  corroborated: 'Phone corroborated',
  supported: 'Public phone supported',
  review: 'Needs review',
  excluded: 'Phone evidence missing',
} as const;

export type QualityFilter = 'all' | 'corroborated' | 'supported' | 'review';

export const compareLeadQuality = (left: Lead, right: Lead) => {
  const order = { corroborated: 3, supported: 2, review: 1, excluded: 0 };
  return order[right.quality?.tier ?? 'review'] - order[left.quality?.tier ?? 'review'] ||
    (right.quality?.score ?? 0) - (left.quality?.score ?? 0);
};

export const matchesQualityFilter = (lead: Lead, filter: QualityFilter) =>
  lead.quality?.tier !== 'excluded' && (filter === 'all' || (lead.quality?.tier ?? 'review') === filter);
