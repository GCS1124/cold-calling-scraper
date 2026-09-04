import type { ResearchDepth, SearchSourceMode, TimeZoneCode } from '../data/search-options';
import type { UsStateCode } from '../data/us-states';

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
  employmentStatus?: EmploymentStatus;
  mobile?: string;
  email?: string;
  website?: string;
  /** Public business website used to verify an email or phone number. */
  contactSourceUrl?: string;
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
  searchId: string;
  leads: Lead[];
  meta: {
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
      publicQueriesAttempted?: number;
      publicProvidersChecked?: number;
      publicQueryFamilies?: string[];
      publicQueryFamilyCounts?: Record<string, number>;
      providerCoverage?: Array<{
        providerId: string;
        providerName: string;
        status: 'configured' | 'not_configured' | 'returned' | 'failed';
        leadCount: number;
        message?: string;
      }>;
      aiAssistance?: 'enabled' | 'disabled' | 'failed';
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
