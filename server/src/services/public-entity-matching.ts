import type { Lead, PublicSocialLink, ReviewCandidate, ReviewCandidateReason } from '../types/lead';
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

const broadLocationPattern = /\b(?:eastern|central|mountain|pacific)\s+time(?:\s+zone)?\b|\b(?:nationwide|united states|usa)\b/i;

const extractComparableCity = (value: unknown, stateCode?: string) => {
  const normalized = normalizeText(value);
  if (!normalized || broadLocationPattern.test(normalized)) return '';

  const withoutZip = normalized.replace(/\b\d{5}(?:-\d{4})?\b/g, '').trim();
  const segments = withoutZip.split(/\s*,\s*/).map((segment) => segment.trim()).filter(Boolean);
  const normalizedState = normalizeText(stateCode);

  if (normalizedState) {
    const stateIndex = segments.findIndex((segment) =>
      segment === normalizedState || segment.split(' ').includes(normalizedState),
    );
    if (stateIndex > 0) {
      return normalizeText(segments[stateIndex - 1]);
    }
  }

  return normalizeText(segments[0] ?? withoutZip);
};

const sameLocation = (person: Lead, listing: Lead) => {
  const personCity = extractComparableCity(person.city, person.stateCode);
  const listingLocations = [listing.city, listing.address]
    .map((value) => extractComparableCity(value, listing.stateCode))
    .filter(Boolean);

  // A broad timezone/nationwide label is intentionally non-specific. State
  // conflicts are still rejected by the match scorer below, while concrete
  // address/city evidence can establish the bridge.
  return (
    !personCity ||
    !listingLocations.length ||
    listingLocations.some(
      (listingLocation) =>
        personCity === listingLocation ||
        personCity.includes(listingLocation) ||
        listingLocation.includes(personCity),
    )
  );
};

const isGoogleBusinessListing = (listing: Lead) =>
  /\b(?:google\s*(?:places|business|maps)|gmb)\b|maps\.google\./i.test(
    [listing.source, listing.listingUrl, listing.contactSourceUrl].filter(Boolean).join(' '),
  );

const listingSourceBoost = (listing: Lead) => {
  if (isGoogleBusinessListing(listing)) return 16;
  if (/\byelp\b/i.test(listing.source)) return 6;
  if (/\byellow\s*pages\b/i.test(listing.source)) return 5;
  if (/\bnotary\s*cafe\b/i.test(listing.source)) return 2;
  return 3;
};

type OrganizationMatch = {
  listing: Lead;
  score: number;
  exactDomain: boolean;
};

type OrganizationMatchAssessment = {
  match?: OrganizationMatch;
  reason?: ReviewCandidateReason;
  detail?: string;
};

const assessOrganizationMatch = (person: Lead, listing: Lead): OrganizationMatchAssessment => {
  if (['former', 'conflicting'].includes(person.employmentStatus ?? '')) {
    return {
      reason: 'former_or_conflicting',
      detail: 'The public professional profile is marked former or conflicting, so it cannot be bridged to a current business listing.',
    };
  }
  if (
    person.stateCode &&
    listing.stateCode &&
    person.stateCode.trim().toUpperCase() !== listing.stateCode.trim().toUpperCase()
  ) {
    return {
      reason: 'location_mismatch',
      detail: 'The public professional profile and business listing identify conflicting states.',
    };
  }

  const personDomain = toDomain(person.website);
  const listingDomain = toDomain(listing.website);
  const exactDomain = Boolean(personDomain && listingDomain && personDomain === listingDomain);
  if (personDomain && listingDomain && !exactDomain) {
    return {
      reason: 'organization_unmatched',
      detail: 'The public professional profile and business listing use conflicting canonical domains.',
    };
  }

  const locationMatched = sameLocation(person, listing);
  if (!exactDomain && !locationMatched) {
    return {
      reason: 'location_mismatch',
      detail: 'The public professional profile and business listing did not share deterministic location evidence.',
    };
  }

  const organization = person.organizationName || extractOrganizationHint(person.headline);
  const organizationTokens = new Set(toTokens(organization));
  const listingTokens = new Set(toTokens(listing.name));
  const overlap = organizationTokens.size && listingTokens.size
    ? [...organizationTokens].filter((token) => listingTokens.has(token)).length
    : 0;
  const coverage = organizationTokens.size && listingTokens.size
    ? overlap / Math.max(organizationTokens.size, listingTokens.size)
    : 0;

  if (!exactDomain && (!organizationTokens.size || !listingTokens.size || coverage < 0.75)) {
    return {
      reason: 'organization_unmatched',
      detail: 'The public organization names did not meet the strict organization-token match threshold.',
    };
  }

  let score = exactDomain ? 100 : 65 + Math.round(coverage * 30);
  if (locationMatched) score += 18;
  if (coverage >= 0.75) score += 15;
  if (normalizeText(organization) && normalizeText(organization) === normalizeText(listing.name)) {
    score += 10;
  }
  score += listingSourceBoost(listing);

  return { match: { listing, score, exactDomain } };
};

const scoreOrganizationMatch = (person: Lead, listing: Lead) =>
  assessOrganizationMatch(person, listing).match;

const hasPublicLinkedInEvidence = (lead: Lead) => {
  const providerText = [
    lead.source,
    ...(Array.isArray(lead.publicEvidence?.sources)
      ? lead.publicEvidence.sources.map((source) => source.providerName)
      : []),
    ...(Array.isArray(lead.evidence)
      ? lead.evidence.map((item) => item?.sourceName)
      : []),
  ].filter((value): value is string => typeof value === 'string').join(' ');

  return /\blink(?:ed\s*-?in)\b/i.test(providerText) || [
    lead.listingUrl,
    lead.contactSourceUrl,
    lead.decisionMakerSourceUrl,
  ].some((value) => isLinkedInProfileListing(value));
};

const listingIdentityKey = (listing: Lead) => {
  const domain = toDomain(listing.website);
  const phone = asString(listing.mobile).replace(/\D/g, '');
  const city = extractComparableCity(listing.city, listing.stateCode) ||
    extractComparableCity(listing.address, listing.stateCode);
  return [domain || normalizeText(listing.name), city, phone].filter(Boolean).join('|');
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
  const selectedPhoneEvidence =
    listingPhoneEvidence.find((item) => item.association === 'business') ??
    listingPhoneEvidence[0] ??
    personPhoneEvidence[0];
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
    // The listing's published business route is the safest phone to carry
    // across a LinkedIn bridge. A person phone remains available as evidence,
    // but is not preferred over the company's public line.
    mobile: selectedPhoneEvidence?.value ?? '',
    email: asString(person.email) || asString(listing.email),
    website: asString(person.website) || asString(listing.website),
    contactSourceUrl: selectedPhoneEvidence?.sourceUrl,
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
    // Gemini can return business candidates, but the final fusion stage is
    // specifically a public LinkedIn-to-business bridge. Keep non-LinkedIn
    // Gemini records in their own tier until they have an actual public
    // LinkedIn profile URL or provider signal.
    if (!hasPublicLinkedInEvidence(person)) {
      return person;
    }

    const matches = safePublicListingLeads
      .map((listing) => scoreOrganizationMatch(person, listing))
      .filter((match): match is OrganizationMatch => Boolean(match))
      .sort((left, right) => right.score - left.score);
    const best = matches[0];
    const second = matches[1];

    if (!best) return person;

    const isDuplicateListing = Boolean(
      second && listingIdentityKey(best.listing) &&
        listingIdentityKey(best.listing) === listingIdentityKey(second.listing),
    );
    const hasClearWinner = !second || isDuplicateListing || best.score - second.score >= 10;
    if (!hasClearWinner) return person;

    usedListingIds.add(best.listing.id);
    return mergePersonWithListing(person, best.listing);
  });

  return { mergedPeople, usedListingIds, safePublicListingLeads };
};

const isLeadRecord = (value: unknown): value is Lead => Boolean(
  value &&
    typeof value === 'object' &&
    typeof (value as Lead).name === 'string' &&
    typeof (value as Lead).id === 'string' &&
    typeof (value as Lead).category === 'string' &&
    typeof (value as Lead).city === 'string' &&
    typeof (value as Lead).source === 'string',
);

const hasPublishedBusinessPhone = (listing: Lead) =>
  getContactEvidence(listing, 'phone').some((evidence) =>
    evidence.association === 'business' || evidence.association === 'unknown',
  );

const fusionReviewCandidate = (
  person: Lead,
  reason: ReviewCandidateReason,
  detail: string,
  listings: Lead[] = [],
): ReviewCandidate => {
  const sourceUrls = [
    person.listingUrl,
    person.decisionMakerSourceUrl,
    person.website,
    ...listings.flatMap((listing) => [listing.listingUrl, listing.contactSourceUrl, listing.website]),
  ].map(toPublicUrl).filter(Boolean);

  return {
    id: `linkedin-gmb-fusion-review-${person.id}-${reason}`,
    providerId: 'linkedin-public-google-business-fusion',
    providerName: 'LinkedIn + Google Business fusion',
    reason,
    reasonDetail: detail,
    name: person.name,
    personName: person.decisionMakerName || person.name,
    organizationName: person.organizationName || extractOrganizationHint(person.headline),
    originalRole: person.originalRole || person.decisionMakerRole || person.headline,
    location: person.address || person.city,
    website: person.website,
    profileUrl: person.listingUrl,
    reportedPhone: person.mobile || undefined,
    reportedEmail: person.email || undefined,
    sourceUrls: [...new Set(sourceUrls)].slice(0, 12),
    evidence: person.publicEvidence?.profileSnippet || person.evidence?.[0]?.claim,
    relatedLeadIds: [person.id, ...listings.map((listing) => listing.id)].slice(0, 12),
    discoveredAt: person.scrapedAt || new Date().toISOString(),
  };
};

/**
 * Strict final fusion with explainable rejections. This deliberately does not
 * merge an ambiguous, former, geographically conflicting, unrelated, or
 * phone-less pairing. The original public records stay independent and a
 * review item preserves the evidence trail.
 */
export const mergeLinkedInWithPublicListingsWithDiagnostics = (
  linkedinLeads: Lead[],
  publicListingLeads: Lead[],
) => {
  const people = (Array.isArray(linkedinLeads) ? linkedinLeads : []).filter(isLeadRecord);
  const listings = (Array.isArray(publicListingLeads) ? publicListingLeads : []).filter(isLeadRecord);
  const usedListingIds = new Set<string>();
  const fusedLeadIds: string[] = [];
  const mergedPeople: Lead[] = [];
  const reviewCandidates: ReviewCandidate[] = [];

  for (const person of people) {
    if (!hasPublicLinkedInEvidence(person)) {
      mergedPeople.push(person);
      continue;
    }

    const assessments = listings.map((listing) => ({
      listing,
      assessment: assessOrganizationMatch(person, listing),
    }));
    const matches = assessments
      .flatMap(({ assessment }) => assessment.match ? [assessment.match] : [])
      .sort((left, right) => right.score - left.score);
    const best = matches[0];
    const second = matches[1];

    if (!best) {
      const rejected = assessments
        .map(({ listing, assessment }) => ({ listing, ...assessment }))
        .filter((assessment): assessment is OrganizationMatchAssessment & { listing: Lead; reason: ReviewCandidateReason } =>
          Boolean(assessment.reason),
        )
        .sort((left, right) => {
          const priority: Record<ReviewCandidateReason, number> = {
            former_or_conflicting: 4,
            location_mismatch: 3,
            organization_unmatched: 2,
            missing_public_phone: 1,
            invalid_public_phone: 0,
            missing_source_evidence: 0,
            category_mismatch: 0,
            organization_ambiguous: 0,
            website_timeout: 0,
            website_blocked: 0,
            provider_timeout: 0,
            provider_blocked: 0,
            provider_rate_limited: 0,
            deferred_by_budget: 0,
          };
          return priority[right.reason] - priority[left.reason];
        })[0];
      if (rejected) {
        reviewCandidates.push(fusionReviewCandidate(
          person,
          rejected.reason,
          rejected.detail ?? 'No strict public organization and location match was found.',
          [rejected.listing],
        ));
      }
      mergedPeople.push(person);
      continue;
    }

    const duplicateListing = Boolean(
      second && listingIdentityKey(best.listing) &&
        listingIdentityKey(best.listing) === listingIdentityKey(second.listing),
    );
    if (second && !duplicateListing && best.score - second.score < 10) {
      reviewCandidates.push(fusionReviewCandidate(
        person,
        'organization_ambiguous',
        'More than one public business listing met the strict match threshold without a clear winner, so no fusion was created.',
        [best.listing, second.listing],
      ));
      mergedPeople.push(person);
      continue;
    }

    if (!hasPublishedBusinessPhone(best.listing)) {
      reviewCandidates.push(fusionReviewCandidate(
        person,
        'missing_public_phone',
        'The organization and location match was corroborated, but the public business listing did not provide a validated business phone route.',
        [best.listing],
      ));
      mergedPeople.push(person);
      continue;
    }

    usedListingIds.add(best.listing.id);
    const merged = mergePersonWithListing(person, best.listing);
    fusedLeadIds.push(merged.id);
    mergedPeople.push(merged);
  }

  return {
    leads: [
      ...mergedPeople,
      ...listings.filter((listing) => !usedListingIds.has(listing.id)),
    ],
    fusedLeadIds: [...new Set(fusedLeadIds)],
    reviewCandidates: [...new Map(reviewCandidates.map((candidate) => [candidate.id, candidate])).values()],
  };
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
