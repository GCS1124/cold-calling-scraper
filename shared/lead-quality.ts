import type { EvidenceSourceFamily } from './source-evidence';

export type LeadQualityTier = 'corroborated' | 'supported' | 'review' | 'excluded';

export type LeadQualitySummary = {
  eligible: number;
  needsReview: number;
  freshPhoneObservations: number;
  tierCounts: Record<LeadQualityTier, number>;
  sourceFamilyLeadCounts: Partial<Record<EvidenceSourceFamily, number>>;
};

export type ContactEvidence = {
  field: 'phone' | 'email';
  value: string;
  sourceUrl: string;
  sourceName: string;
  sourceKind: 'business_listing' | 'business_website' | 'public_snippet';
  observedAt?: string;
  association: 'business' | 'person' | 'unknown';
};

/**
 * A conservative, derived status for the outreach route represented by a
 * lead. "Paired" means an explicitly published human name has a public
 * source and the lead's selected phone has independent public evidence. It
 * does not claim personal ownership of a business line.
 */
export type DecisionMakerPhonePairStatus =
  | 'paired'
  | 'decision_maker_only'
  | 'phone_only'
  | 'unpaired';

export type DecisionMakerPhonePair = {
  status: DecisionMakerPhonePairStatus;
  phoneAssociation: ContactEvidence['association'];
  phoneSourceUrl?: string;
  phoneSourceName?: string;
  personSourceUrl?: string;
};

export type WebsiteAssessment = {
  version: 1;
  status: 'confirmed' | 'probable' | 'parked' | 'unrelated' | 'unavailable' | 'blocked';
  /** Deterministic identity score, not a probability of correctness. */
  score: number;
  canonicalHost: string;
  sourceUrl: string;
  resolvedHost?: string;
  observedAt: string;
  contentHash?: string;
  robots: 'allowed' | 'blocked' | 'unknown';
  reasons: string[];
  gaps: string[];
};

export type LeadQualityAssessment = {
  version: 1;
  tier: LeadQualityTier;
  score: number;
  reasons: string[];
  gaps: string[];
  nextAction: string;
  sourceKinds: ContactEvidence['sourceKind'][];
  /** Independent source families, not repeated URLs from one provider. */
  independentSourceCount?: number;
  sourceFamilies?: EvidenceSourceFamily[];
  lastObservedAt?: string;
  freshness: 'recent' | 'stale' | 'unknown';
  phone: {
    assessedValue: string;
    formatValid: boolean;
    publiclyObserved: boolean;
    association: ContactEvidence['association'];
    sourceUrls: string[];
    lineType: 'unknown';
    reachability: 'not_checked';
  };
  email: {
    formatValid: boolean;
    publiclyObserved: boolean;
    mailbox: 'not_checked';
    sourceUrls: string[];
  };
};
