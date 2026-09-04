import type { Lead, PublicSocialLink } from '../types/lead';
import { enrichLead } from './lead-validation';

const companySuffixPattern =
  /\b(private limited|pvt ltd|pvt\. ltd\.?|limited|ltd\.?|llc|inc\.?|incorporated|corp\.?|corporation|company|co\.?)\b/gi;

const normalizeText = (value?: string) =>
  (value ?? '')
    .toLowerCase()
    .replace(companySuffixPattern, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toDomain = (value?: string) => {
  if (!value?.trim()) return '';

  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname
      .replace(/^www\./i, '')
      .toLowerCase();
  } catch {
    return '';
  }
};

const toTokens = (value?: string) =>
  normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 3);

const extractOrganizationHint = (headline?: string) => {
  const normalized = (headline ?? '').replace(/\s+/g, ' ').trim();
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
  if (!sameLocation(person, listing)) {
    return false;
  }

  const personDomain = toDomain(person.website);
  const listingDomain = toDomain(listing.website);

  if (personDomain && listingDomain) {
    return personDomain === listingDomain;
  }

  const organization = extractOrganizationHint(person.headline);
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

  for (const link of [...(person.publicSocialLinks ?? []), ...(listing.publicSocialLinks ?? [])]) {
    if (link.url.trim() && !links.has(link.url.trim())) {
      links.set(link.url.trim(), { ...link, url: link.url.trim() });
    }
  }

  return [...links.values()].slice(0, 20);
};

const mergePersonWithListing = (person: Lead, listing: Lead) =>
  enrichLead({
    ...person,
    mobile: person.mobile || listing.mobile,
    email: person.email || listing.email,
    website: person.website || listing.website,
    contactSourceUrl:
      person.contactSourceUrl ||
      ((listing.mobile || listing.email) && listing.listingUrl ? listing.listingUrl : undefined),
    publicSocialLinks: mergeSocialLinks(person, listing),
    address: person.address || listing.address,
    state: person.state || listing.state,
    stateCode: person.stateCode || listing.stateCode,
    postalCode: person.postalCode || listing.postalCode,
    zip: person.zip || listing.zip,
    source: [person.source, listing.source].filter(Boolean).join(', '),
    confidence: Math.max(person.confidence, listing.confidence),
    evidence: [
      ...(person.evidence ?? []),
      ...(listing.evidence ?? []),
      ...(listing.listingUrl
        ? [
            {
              sourceUrl: listing.listingUrl,
              sourceName: listing.source || 'Public business listing',
              claim: `Public business listing corroborates ${person.name}'s organization and contact route.`,
              status: 'corroborated' as const,
              observedAt: listing.scrapedAt,
            },
          ]
        : []),
    ],
  });

const matchLinkedInPeopleToPublicListings = (
  linkedinLeads: Lead[],
  publicListingLeads: Lead[],
) => {
  const usedListingIds = new Set<string>();
  const mergedPeople = linkedinLeads.map((person) => {
    const matches = publicListingLeads.filter(
      (listing) => !usedListingIds.has(listing.id) && hasStrongOrganizationMatch(person, listing),
    );

    if (matches.length !== 1) {
      return person;
    }

    const [listing] = matches;
    if (!listing) return person;

    usedListingIds.add(listing.id);
    return mergePersonWithListing(person, listing);
  });

  return { mergedPeople, usedListingIds };
};

/**
 * Bridge only corroborated listing data into LinkedIn profiles. Unmatched
 * listings stay out of LinkedIn mode so its result set remains profile-led.
 */
export const bridgeLinkedInWithPublicListings = (
  linkedinLeads: Lead[],
  publicListingLeads: Lead[],
) => matchLinkedInPeopleToPublicListings(linkedinLeads, publicListingLeads).mergedPeople;

export const mergeLinkedInWithPublicListings = (
  linkedinLeads: Lead[],
  publicListingLeads: Lead[],
) => {
  const { mergedPeople, usedListingIds } = matchLinkedInPeopleToPublicListings(
    linkedinLeads,
    publicListingLeads,
  );

  return [
    ...mergedPeople,
    ...publicListingLeads.filter((listing) => !usedListingIds.has(listing.id)),
  ];
};
