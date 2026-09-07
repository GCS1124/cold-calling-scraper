import type {
  ContactEvidence,
  LeadQualityAssessment,
  WebsiteAssessment,
} from '../../../shared/lead-quality';
import type {
  EvidenceAuthorityTier,
  EvidenceSourceFamily,
} from '../../../shared/source-evidence';
import type { OpportunitySignalType } from '../../../shared/opportunity-signals';

export type PublicSocialLink = {
  platform:
    | 'Facebook'
    | 'Instagram'
    | 'LinkedIn'
    | 'X'
    | 'TikTok'
    | 'YouTube'
    | 'Google Business'
    | 'Yelp'
    | 'Other';
  url: string;
};

export type LeadEvidence = {
  sourceUrl: string;
  sourceName: string;
  sourceFamily?: EvidenceSourceFamily;
  authorityTier?: EvidenceAuthorityTier;
  claim: string;
  status:
    | 'confirmed'
    | 'corroborated'
    | 'inferred'
    | 'stale'
    | 'conflicting'
    | 'rejected'
    | 'unknown';
  observedAt?: string;
};

export type LeadScores = {
  trust: number;
  fit: number;
  contactability: number;
  opportunity: number;
  priority: number;
  /** Independent source families, not a count of URLs or repeated search results. */
  independentSourceCount: number;
  sourceFamilies: EvidenceSourceFamily[];
  opportunityTypes?: OpportunitySignalType[];
  contradictionFlags?: string[];
  contradictionPenalty?: number;
  reasons: string[];
};

export type EmploymentStatus =
  | 'current'
  | 'probable'
  | 'uncertain'
  | 'conflicting'
  | 'former'
  | 'unverified';

export type Lead = {
  id: string;
  name: string;
  headline?: string;
  /** Organization associated with a professional profile, when publicly evidenced. */
  organizationName?: string;
  /** Preserve the published title separately from the normalized role label. */
  originalRole?: string;
  normalizedRole?: string;
  decisionMaker?: boolean;
  /** Public-result status only; never inferred from a private or authenticated profile. */
  employmentStatus?: EmploymentStatus;
  mobile?: string;
  email?: string;
  website?: string;
  /** Public business website used to verify an email or phone number. */
  contactSourceUrl?: string;
  contactEvidence?: ContactEvidence[];
  quality?: LeadQualityAssessment;
  websiteAssessment?: WebsiteAssessment;
  /** Social links published by the lead's public business website. */
  publicSocialLinks?: PublicSocialLink[];
  /** Bounded public search-result evidence used for manual verification. */
  publicEvidence?: {
    profileTitle?: string;
    profileSnippet?: string;
    sources?: Array<{
      providerName: string;
      profileTitle?: string;
      profileSnippet?: string;
    }>;
  };
  evidence?: LeadEvidence[];
  scores?: LeadScores;
  opportunitySignals?: string[];
  address?: string;
  state?: string;
  stateCode?: string;
  postalCode?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
  category: string;
  city: string;
  source: string;
  confidence: number;
  sourceScore?: number;
  matchSignals?: {
    queryMatches: number;
    publicSources: number;
    publicProviderNames?: string[];
    categoryMatchedTerms?: string[];
    roleMatchedTerms?: string[];
    queryFamilies?: string[];
    locationEvidence?: string;
    categoryMatched?: boolean;
    ownerMatched?: boolean;
    roleMatched: boolean;
    locationMatched: boolean;
  };
  listingUrl?: string;
  crawlAttempts?: number;
  rejectionReason?:
    | 'missing_email'
    | 'missing_phone'
    | 'invalid_phone'
    | 'invalid_email'
    | 'blocked_website'
    | 'blocked_google'
    | 'duplicate'
    | 'non_business_site'
    | 'missing_contact';
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  verifiedPhone: boolean;
  verifiedEmail: boolean;
  scrapedAt: string;
};
