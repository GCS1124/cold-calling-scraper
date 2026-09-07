import type { EvidenceSourceFamily } from './source-evidence';

export type ContactEvidence = {
  field: 'phone' | 'email';
  value: string;
  sourceUrl: string;
  sourceName: string;
  sourceKind: 'business_listing' | 'business_website' | 'public_snippet';
  observedAt?: string;
  association: 'business' | 'person' | 'unknown';
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
  tier: 'corroborated' | 'supported' | 'review' | 'excluded';
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
