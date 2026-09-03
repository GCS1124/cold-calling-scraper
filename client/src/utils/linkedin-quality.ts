import type { Lead } from '../types/lead';

export type LinkedInSortMode = 'best-match' | 'contact-ready' | 'corroborated';

export type LinkedInLeadReadiness =
  | 'email-and-phone'
  | 'email'
  | 'phone'
  | 'website'
  | 'profile-only';

export type LinkedInQualityTier = 'A' | 'B' | 'C';

const ownerRolePattern =
  /\b(founder|co-founder|owner|co-owner|business owner|owner operator|proprietor|franchisee|franchise owner|president|principal|managing partner|managing member|brand owner|brand founder|practice owner|clinic owner|store owner|agency principal|insurance agency owner|dealer principal)\b/i;

export function hasPublicOwnerSignal(lead: Lead) {
  return Boolean(
    lead.matchSignals?.ownerMatched ||
      lead.matchSignals?.roleMatchedTerms?.some((term) => ownerRolePattern.test(term)),
  );
}

export function getLinkedInLeadReadiness(lead: Lead): LinkedInLeadReadiness {
  if (lead.hasEmail && lead.hasPhone) {
    return 'email-and-phone';
  }

  if (lead.hasEmail) {
    return 'email';
  }

  if (lead.hasPhone) {
    return 'phone';
  }

  if (lead.hasWebsite) {
    return 'website';
  }

  return 'profile-only';
}

export function getLinkedInReadinessLabel(lead: Lead) {
  const labels: Record<LinkedInLeadReadiness, string> = {
    'email-and-phone': 'Email + phone',
    email: 'Email listed',
    phone: 'Phone listed',
    website: 'Website found',
    'profile-only': 'Profile only',
  };

  return labels[getLinkedInLeadReadiness(lead)];
}

export function isContactReadyLinkedInLead(lead: Lead) {
  return lead.hasEmail || lead.hasPhone;
}

export function isEvidenceBackedLinkedInLead(lead: Lead) {
  return Boolean(lead.publicEvidence?.profileTitle || lead.publicEvidence?.profileSnippet);
}

export function getLinkedInQualityTier(lead: Lead): LinkedInQualityTier {
  const signals = lead.matchSignals;
  const hasLocation = Boolean(signals?.locationMatched);
  const hasRole = Boolean(signals?.roleMatched);
  const hasCategory = signals?.categoryMatched !== false;
  const hasCorroboration = (signals?.publicSources ?? 0) >= 2 || (signals?.queryMatches ?? 0) >= 3;

  if (
    lead.confidence >= 90 &&
    hasCategory &&
    hasLocation &&
    hasRole &&
    hasCorroboration
  ) {
    return 'A';
  }

  if (
    lead.confidence >= 80 &&
    hasCategory &&
    (hasLocation || hasRole) &&
    isEvidenceBackedLinkedInLead(lead)
  ) {
    return 'B';
  }

  return 'C';
}

export function getLinkedInRankingScore(lead: Lead, sortMode: LinkedInSortMode) {
  const signals = lead.matchSignals;
  const contactScore = Number(lead.hasEmail) * 18 + Number(lead.hasPhone) * 18;
  const ownerScore = Number(hasPublicOwnerSignal(lead)) * 10;
  const evidenceScore =
    Math.min(4, signals?.queryMatches ?? 0) * 3 +
    Math.min(3, signals?.publicSources ?? 0) * 7 +
    Number(isEvidenceBackedLinkedInLead(lead)) * 8;

  if (sortMode === 'contact-ready') {
    return contactScore * 4 + lead.confidence + evidenceScore + ownerScore;
  }

  if (sortMode === 'corroborated') {
    return evidenceScore * 4 + lead.confidence + contactScore + ownerScore;
  }

  return lead.confidence * 2 + evidenceScore + contactScore + ownerScore;
}

export function isHighFitLinkedInLead(lead: Lead) {
  const signals = lead.matchSignals;

  return Boolean(
    lead.confidence >= 85 &&
      signals?.locationMatched &&
      signals.categoryMatched !== false &&
      (signals.roleMatched || signals.publicSources >= 2),
  );
}
