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

export type Lead = {
  id: string;
  name: string;
  headline?: string;
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
