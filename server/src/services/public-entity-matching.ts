import type { Lead, PublicSocialLink } from '../types/lead';
import { enrichLead } from './lead-validation';
import { collectContactEvidence, getContactEvidence, mergeContactEvidence } from './contact-evidence';
import { isPublicHttpUrl } from '../utils/public-url';

const companySuffixPattern =
  /\b(private limited|pvt ltd|pvt\. ltd\.?|limited|ltd\.?|llc|inc\.?|incorporated|corp\.?|corporation|company|co\.?)\b/gi;

const asString = (value: unknown) => (typeof value === 'string' ? value : '');

const toPublicUrl = (value: unknown) => {
  const candidate = asString(value).trim();
  if (!candidate) return '';
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  return isPublicHttpUrl(withProtocol) ? withProtocol : '';
};

const normalizeText = (value?: unknown) =>
  asString(value)
    .toLowerCase()
    .replace(companySuffixPattern, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toDomain = (value?: unknown) => {
  const candidate = toPublicUrl(value);
  if (!candidate) return '';

  try {
    return new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`).hostname
      .replace(/^www\./i, '')
      .toLowerCase();
  } catch {
    return '';
  }
};

const isLinkedInProfileListing = (value?: unknown) => {
  const candidate = toPublicUrl(value);
  return Boolean(
    candidate &&
      isPublicHttpUrl(candidate) &&
      /(?:^|\/\/)(?:www\.)?linkedin\.com\/(?:in|pub)\//i.test(candidate),
  );
};

const toTokens = (value?: unknown) =>
  normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 3);

export const extractOrganizationHint = (headline?: unknown) => {
  const normalized = asString(headline).replace(/\s+/g, ' ').trim();
  const match = normalized.match(
    /\b(?:at|@|with|for|of|owner of|founder of|principal of)\s+(.+?)(?:\s*[|•·].*)?$/i,
  );

  return (match?.[1] ?? '').replace(/\s*[-|].*$/g, '').trim();
};

const sameLocation = (person: Lead, listing: Lead) => {
  const personCity = normalizeText(person.city);
  const listingLocations = [listing.city, listing.address].map(normalizeText).filter(Boolean);

  return (
    !personCity ||
    !listingLocations.length ||
    listingLocations.some(
      (listingLocation) =>
        personCity.includes(listingLocation) || listingLocation.includes(personCity),
    )
  );
};

const hasStrongOrganizationMatch = (person: Lead, listing: Lead) => {
  if (['former', 'conflicting'].includes(person.employmentStatus ?? '')) return false;
  if (person.stateCode && listing.stateCode && person.stateCode !== listing.stateCode) return false;

  const personDomain = toDomain(person.website);
  const listingDomain = toDomain(listing.website);

  // An exact public company domain is stronger than a broad or differently
  // formatted location string (for example, a profile in Miami matched to a
  // timezone-scoped listing). State conflicts were rejected above.
  if (personDomain && listingDomain) {
    return personDomain === listingDomain;
  }

  if (!sameLocation(person, listing)) {
    return false;
  }

  const organization = person.organizationName || extractOrganizationHint(person.headline);
  if (!organization) {
    return false;
  }

  const organizationTokens = new Set(toTokens(organization));
  const listingTokens = new Set(toTokens(listing.name));

  if (!organizationTokens.size || !listingTokens.size) {
    return false;
  }

  const overlap = [...organizationTokens].filter((token) => listingTokens.has(token)).length;
  const coverage = overlap / Math.max(organizationTokens.size, listingTokens.size);

  return coverage >= 0.75;
};

const mergeSocialLinks = (person: Lead, listing: Lead): PublicSocialLink[] => {
  const links = new Map<string, PublicSocialLink>();
  const supportedPlatforms = new Set<PublicSocialLink['platform']>([
    'Facebook', 'Instagram', 'LinkedIn', 'X', 'TikTok', 'YouTube',
    'Google Business', 'Yelp', 'Other',
  ]);

  const candidates = [
    ...(Array.isArray(person.publicSocialLinks) ? person.publicSocialLinks : []),
    ...(Array.isArray(listing.publicSocialLinks) ? listing.publicSocialLinks : []),
  ];

  for (const link of candidates) {
    if (!link || typeof link !== 'object' || typeof link.url !== 'string') continue;
    const url = link.url.trim();
    if (url && isPublicHttpUrl(url) && !links.has(url)) {
      const platform = typeof link.platform === 'string' &&
        supportedPlatforms.has(link.platform as PublicSocialLink['platform'])
        ? link.platform as PublicSocialLink['platform']
        : 'Other';
      links.set(url, {
        platform,
        url,
      });
    }
  }

  return [...links.values()].slice(0, 20);
};

const mergePersonWithListing = (person: Lead, listing: Lead) => {
  const personName = asString(person.name);
  const listingName = asString(listing.name);
  const personOrganizationName = asString(person.organizationName);
  const decisionMakerName = asString(person.decisionMakerName) || (
    personName &&
    normalizeText(personName) !== normalizeText(listingName) &&
    (personOrganizationName || isLinkedInProfileListing(person.listingUrl))
      ? personName
      : undefined
  );
  const personPhoneEvidence = getContactEvidence(person, 'phone');
  const listingPhoneEvidence = getContactEvidence(listing, 'phone');
  const personEvidence = Array.isArray(person.evidence) ? person.evidence : [];
  const listingEvidence = Array.isArray(listing.evidence) ? listing.evidence : [];

  const merged = {
    ...person,
    name: personName,
    headline: asString(person.headline),
    category: asString(person.category),
    city: asString(person.city),
    scrapedAt: asString(person.scrapedAt),
    organizationName: listingName,
    ...(decisionMakerName ? { decisionMakerName } : {}),
    ...(decisionMakerName && (asString(person.decisionMakerRole) || asString(person.originalRole) || asString(person.headline))
      ? { decisionMakerRole: asString(person.decisionMakerRole) || asString(person.originalRole) || asString(person.headline) }
      : {}),
    ...(decisionMakerName && (asString(person.decisionMakerSourceUrl) || asString(person.listingUrl))
      ? { decisionMakerSourceUrl: asString(person.decisionMakerSourceUrl) || asString(person.listingUrl) }
      : {}),
    originalRole: asString(person.originalRole) || asString(person.headline),
    mobile: personPhoneEvidence.length ? asString(person.mobile) : asString(listing.mobile),
    email: asString(person.email) || asString(listing.email),
    website: asString(person.website) || asString(listing.website),
    contactSourceUrl:
      (personPhoneEvidence.length ? personPhoneEvidence : listingPhoneEvidence)[0]?.sourceUrl,
    contactEvidence: mergeContactEvidence([
      ...collectContactEvidence(person),
      ...collectContactEvidence(listing).map((item) => ({ ...item, association: 'business' as const })),
    ]),
    publicSocialLinks: mergeSocialLinks(person, listing),
    address: asString(person.address) || asString(listing.address),
    state: asString(person.state) || asString(listing.state),
    stateCode: asString(person.stateCode) || asString(listing.stateCode),
    postalCode: asString(person.postalCode) || asString(listing.postalCode),
    zip: asString(person.zip) || asString(listing.zip),
    source: [asString(person.source), asString(listing.source)].filter(Boolean).join(', '),
    confidence: Math.max(
      typeof person.confidence === 'number' && Number.isFinite(person.confidence) ? person.confidence : 0,
      typeof listing.confidence === 'number' && Number.isFinite(listing.confidence) ? listing.confidence : 0,
    ),
    evidence: [
      ...personEvidence,
      ...listingEvidence,
      ...(listing.listingUrl
        ? [
            {
              sourceUrl: asString(listing.listingUrl),
              sourceName: asString(listing.source) || 'Public business listing',
              claim: `Public business listing corroborates ${personName}'s organization and contact route.`,
              status: 'corroborated' as const,
              observedAt: listing.scrapedAt,
            },
          ]
        : []),
    ],
  };

  try {
    return enrichLead(merged);
  } catch {
    // A provider or persisted payload can be structurally malformed even when
    // its required identity fields look valid. Preserve the person record,
    // but never let one bad bridge candidate break the entire search.
    return merged;
  }
};

const matchLinkedInPeopleToPublicListings = (
  linkedinLeads: Lead[],
  publicListingLeads: Lead[],
) => {
  const isLeadRecord = (value: unknown): value is Lead => Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as Lead).name === 'string' &&
      typeof (value as Lead).id === 'string' &&
      typeof (value as Lead).category === 'string' &&
      typeof (value as Lead).city === 'string' &&
      typeof (value as Lead).source === 'string',
  );
  const safeLinkedInLeads = (Array.isArray(linkedinLeads) ? linkedinLeads : []).filter(isLeadRecord);
  const safePublicListingLeads = (Array.isArray(publicListingLeads) ? publicListingLeads : []).filter(isLeadRecord);
  const usedListingIds = new Set<string>();
  const mergedPeople = safeLinkedInLeads.map((person) => {
    const matches = safePublicListingLeads.filter(
      (listing) => hasStrongOrganizationMatch(person, listing),
    );

    if (matches.length !== 1) {
      return person;
    }

    const [listing] = matches;
    if (!listing) return person;

    usedListingIds.add(listing.id);
    return mergePersonWithListing(person, listing);
  });

  return { mergedPeople, usedListingIds, safePublicListingLeads };
};

/**
 * Bridge only corroborated listing data into public professional profiles.
 * Unmatched listings remain in the AI fusion pool as independent business
 * candidates rather than being attached to an unrelated person.
 */
export const bridgeLinkedInWithPublicListings = (
  linkedinLeads: Lead[],
  publicListingLeads: Lead[],
) => matchLinkedInPeopleToPublicListings(linkedinLeads, publicListingLeads).mergedPeople;

export const mergeLinkedInWithPublicListings = (
  linkedinLeads: Lead[],
  publicListingLeads: Lead[],
) => {
  const { mergedPeople, usedListingIds, safePublicListingLeads } = matchLinkedInPeopleToPublicListings(
    linkedinLeads,
    publicListingLeads,
  );

  return [
    ...mergedPeople,
    ...safePublicListingLeads.filter((listing) => !usedListingIds.has(listing.id)),
  ];
};
