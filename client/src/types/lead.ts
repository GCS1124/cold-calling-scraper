import type { ResearchDepth, SearchSourceMode, TimeZoneCode } from '../data/search-options';
import type { UsStateCode } from '../data/us-states';
import type {
  ContactEvidence,
  DecisionMakerPhonePair,
  LeadQualityAssessment,
  WebsiteAssessment,
} from '../../../shared/lead-quality';
import type {
  EvidenceAuthorityTier,
  EvidenceSourceFamily,
} from '../../../shared/source-evidence';
import type { OpportunitySignalType } from '../../../shared/opportunity-signals';
import type { LeadQualitySummary } from '../../../shared/lead-quality';
import type {
  PhonePolicyContract,
  SearchExecutionContract,
  SearchModeCode,
  SEARCH_RESPONSE_CONTRACT_VERSION,
} from '../../../shared/search-contract';

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

/** Model-reported public research retained separately from phone-qualified leads. */
export type ResearchCandidate = {
  id: string;
  name?: string;
  /** Explicit human name returned by a grounded public source. */
  personName?: string;
  organizationName?: string;
  originalRole?: string;
  location?: string;
  website?: string;
  profileUrl?: string;
  reportedPhone?: string;
  reportedEmail?: string;
  socialLinks?: Array<{ platform: string; url: string }>;
  sourceUrls: string[];
  sourceTitles?: string[];
  evidence?: string;
  grounded: boolean;
  status: 'needs_phone_validation' | 'needs_source_review';
  discoveredAt: string;
};

export type ReviewCandidateReason =
  | 'missing_public_phone'
  | 'invalid_public_phone'
  | 'missing_source_evidence'
  | 'category_mismatch'
  | 'location_mismatch'
  | 'organization_unmatched'
  | 'organization_ambiguous'
  | 'former_or_conflicting'
  | 'website_timeout'
  | 'website_blocked'
  | 'provider_timeout'
  | 'provider_blocked'
  | 'provider_rate_limited'
  | 'deferred_by_budget';

export type ReviewCandidate = {
  id: string;
  providerId: string;
  providerName: string;
  reason: ReviewCandidateReason;
  reasonDetail?: string;
  name?: string;
  personName?: string;
  organizationName?: string;
  originalRole?: string;
  location?: string;
  website?: string;
  profileUrl?: string;
  reportedPhone?: string;
  reportedEmail?: string;
  sourceUrls: string[];
  sourceTitles?: string[];
  evidence?: string;
  relatedLeadIds?: string[];
  discoveredAt: string;
};

export type Lead = {
  id: string;
  name: string;
  headline?: string;
  employmentStatus?: EmploymentStatus;
  organizationName?: string;
  /** Publicly evidenced human decision-maker associated with the organization. */
  decisionMakerName?: string;
  decisionMakerRole?: string;
  decisionMakerSourceUrl?: string;
  /** Derived public-evidence pairing state for safe outreach routing. */
  decisionMakerPhonePair?: DecisionMakerPhonePair;
  originalRole?: string;
  normalizedRole?: string;
  decisionMaker?: boolean;
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

export type ProviderCoverage = {
  providerId: string;
  providerName: string;
  status: 'configured' | 'not_configured' | 'returned' | 'failed' | 'partial';
  leadCount: number;
  phase?: 'queued' | 'running' | 'completed' | 'degraded' | 'skipped';
  outcome?:
    | 'not_started'
    | 'returned'
    | 'empty'
    | 'timed_out'
    | 'blocked'
    | 'rate_limited'
    | 'failed'
    | 'filtered'
    | 'deferred'
    | 'not_configured';
  attemptedCount?: number;
  observedCount?: number;
  acceptedCount?: number;
  reviewCount?: number;
  deferredCount?: number;
  completedCount?: number;
  enrichedCount?: number;
  blockedCount?: number;
  timedOutCount?: number;
  skippedCount?: number;
  decisionMakerRecoveredCount?: number;
  updatedAt?: string;
  message?: string;
};

export type SearchLocation =
  | {
      mode: 'timezone';
      timeZone: TimeZoneCode;
    }
  | {
      mode: 'cityState';
      city: string;
      stateCode: UsStateCode;
    };

export type SearchRequest = {
  companyType: string;
  location: SearchLocation;
  count: number;
  /** The app only accepts leads with a validated public phone/mobile number. */
  phoneRequired?: true;
  sourceMode?: SearchSourceMode;
  researchDepth?: ResearchDepth;
  researchBrief?: string;
  filters?: {
    hasEmail?: boolean;
    hasPhone?: boolean;
    hasWebsite?: boolean;
    sources?: string[];
  };
};

export type SearchDraft = {
  companyType: string;
  sourceMode: SearchSourceMode;
  locationMode: SearchLocation['mode'];
  timeZone: TimeZoneCode | '';
  city: string;
  stateCode: UsStateCode | '';
  count: number;
  researchDepth: ResearchDepth;
  researchBrief: string;
};

export type SearchStatus =
  | 'queued'
  | 'discovering'
  | 'enriching'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type SearchResponse = {
  contractVersion?: typeof SEARCH_RESPONSE_CONTRACT_VERSION;
  searchId: string;
  leads: Lead[];
  researchCandidates?: ResearchCandidate[];
  reviewCandidates?: ReviewCandidate[];
  meta: {
    sourceMode?: SearchModeCode;
    execution?: SearchExecutionContract;
    requestId?: string;
    qualitySummary?: LeadQualitySummary;
    phonePolicy?: PhonePolicyContract;
    limitations?: string[];
    query: string;
    locationLabel: string;
    researchDepth?: ResearchDepth;
    researchBrief?: string;
    status: SearchStatus;
    progress: {
      discovered: number;
      enriched: number;
      publicContactsFound?: number;
      phoneExcludedCount?: number;
      suppressedCount?: number;
      publicQueriesAttempted?: number;
      publicProvidersChecked?: number;
      publicQueryFamilies?: string[];
      publicQueryFamilyCounts?: Record<string, number>;
      providerCoverage?: ProviderCoverage[];
      aiAssistance?: 'enabled' | 'disabled' | 'failed' | 'rate_limited';
      totalCandidates: number;
      requestedCount: number;
      foundCount: number;
      duplicatesRemoved: number;
      currentSource: string;
      batchesCompleted: number;
      estimatedRemaining: number;
    };
    totals: {
      total: number;
      withEmail: number;
      withPhone: number;
      withWebsite: number;
    };
  providerWarnings: Array<{
    providerId: string;
    providerName: string;
    message: string;
    severity?: 'info' | 'warning' | 'error';
  }>;
  };
};
