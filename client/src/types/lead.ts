import type { TimeZoneCode } from '../data/search-options';
import type { UsStateCode } from '../data/us-states';

export type Lead = {
  id: string;
  name: string;
  mobile?: string;
  email?: string;
  website?: string;
  address?: string;
  category: string;
  city: string;
  source: string;
  confidence: number;
  sourceScore?: number;
  listingUrl?: string;
  crawlAttempts?: number;
  rejectionReason?:
    | 'missing_email'
    | 'missing_phone'
    | 'invalid_phone'
    | 'blocked_website'
    | 'blocked_google'
    | 'duplicate'
    | 'non_business_site';
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
  filters?: {
    hasEmail?: boolean;
    hasPhone?: boolean;
    hasWebsite?: boolean;
    sources?: string[];
  };
};

export type SearchDraft = {
  companyType: string;
  locationMode: SearchLocation['mode'];
  timeZone: TimeZoneCode | '';
  city: string;
  stateCode: UsStateCode | '';
  count: number;
};

export type SearchStatus =
  | 'queued'
  | 'discovering'
  | 'enriching'
  | 'complete'
  | 'failed';

export type SearchResponse = {
  searchId: string;
  leads: Lead[];
  meta: {
    query: string;
    locationLabel: string;
    status: SearchStatus;
    progress: {
      discovered: number;
      enriched: number;
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
    }>;
  };
};
