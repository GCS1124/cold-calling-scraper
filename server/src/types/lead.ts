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
  qualified: boolean;
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
