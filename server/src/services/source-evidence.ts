import type { ContactEvidence } from '../../../shared/lead-quality';
import type {
  EvidenceAuthorityTier,
  EvidenceSourceFamily,
} from '../../../shared/source-evidence';

import type { Lead } from '../types/lead';
import { isNotaryCafeHost, isPublicHttpUrl } from '../utils/public-url';

export type SourceObservation = {
  sourceUrl?: string;
  sourceName: string;
  sourceFamily: EvidenceSourceFamily;
  authorityTier: EvidenceAuthorityTier;
  observedAt?: string;
};

const normalizeHost = (value?: unknown) => {
  if (typeof value !== 'string' || !value.trim() || !isPublicHttpUrl(value)) {
    return '';
  }

  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
};

const hostMatches = (host: string, pattern: RegExp) => pattern.test(host);

export const samePublicHost = (left?: string, right?: string) => {
  const leftHost = normalizeHost(left);
  const rightHost = normalizeHost(right);
  return Boolean(leftHost && rightHost && leftHost === rightHost);
};

const sourceFamilyFor = ({
  sourceUrl,
  sourceName,
  sourceKind,
  officialWebsite,
}: {
  sourceUrl?: string;
  sourceName?: string;
  sourceKind?: ContactEvidence['sourceKind'];
  officialWebsite?: boolean;
}): EvidenceSourceFamily => {
  const name = typeof sourceName === 'string' ? sourceName.trim().toLowerCase() : '';
  const host = normalizeHost(sourceUrl);
  const isGoogleSearchResult =
    hostMatches(host, /(?:^|\.)google\.[a-z.]+$/) &&
    !/\/maps\b/i.test(typeof sourceUrl === 'string' ? sourceUrl : '') &&
    /search|snippet/i.test(name);
  const isGoogleMapsResult =
    hostMatches(host, /(?:^|\.)google\.com$/) && /\/maps\b/i.test(typeof sourceUrl === 'string' ? sourceUrl : '');
  const isOpenStreetMapResult = hostMatches(host, /(?:^|\.)openstreetmap\.org$/);
  const isNotaryCafeSource = isNotaryCafeHost(sourceUrl ?? '');

  if (isNotaryCafeSource) {
    return 'search_engine';
  }

  if (officialWebsite === true) {
    return 'official_business';
  }

  if (officialWebsite === false || sourceKind === 'business_website') {
    return 'public_website';
  }

  if (
    sourceKind === 'public_snippet' ||
    isGoogleSearchResult ||
    hostMatches(host, /(?:^|\.)bing\.com$/) ||
    hostMatches(host, /(?:^|\.)duckduckgo\.com$/) ||
    hostMatches(host, /(?:^|\.)search\.brave\.com$/) ||
    hostMatches(host, /(?:^|\.)search\.yahoo\.com$/)
  ) {
    return 'search_engine';
  }

  if (
    hostMatches(host, /(?:^|\.)linkedin\.com$/) ||
    /\b(?:linkedin|professional profile|public profile)\b/i.test(name)
  ) {
    return 'professional_profile';
  }

  if (
    host.endsWith('.gov') ||
    host.endsWith('.mil') ||
    /\b(?:government|registry|licen[cs](?:e|ing)|secretary of state|board)\b/i.test(name)
  ) {
    return 'government_or_licensing';
  }

  if (/\b(?:association|chamber|guild|institute|society|trade group)\b/i.test(name)) {
    return 'trade_association';
  }

  if (/\b(?:news|journal|press|publication|magazine)\b/i.test(name)) {
    return 'news';
  }

  if (
    hostMatches(host, /(?:^|\.)facebook\.com$/) ||
    hostMatches(host, /(?:^|\.)instagram\.com$/) ||
    hostMatches(host, /(?:^|\.)youtube\.com$/) ||
    hostMatches(host, /(?:^|\.)tiktok\.com$/) ||
    hostMatches(host, /(?:^|\.)x\.com$/) ||
    /\b(?:social|facebook|instagram|youtube|tiktok|twitter)\b/i.test(name)
  ) {
    return 'social';
  }

  if (
    isGoogleMapsResult ||
    isOpenStreetMapResult ||
    /\b(?:listing|maps|google business|openstreetmap|osm)\b/i.test(name)
  ) {
    return 'business_listing';
  }

  if (
    /\b(?:directory|yellow pages|yelp|manta|superpages|angi|bbb)\b/i.test(name) ||
    hostMatches(host, /(?:^|\.)yelp\.com$/) ||
    hostMatches(host, /(?:^|\.)yellowpages\.com$/)
  ) {
    return 'directory';
  }

  return sourceUrl ? 'public_website' : 'unknown';
};

export const authorityTierFor = (
  family: EvidenceSourceFamily,
): EvidenceAuthorityTier => {
  if (family === 'official_business' || family === 'government_or_licensing') return 'A';
  if (family === 'trade_association' || family === 'news') return 'B';
  if (
    family === 'business_listing' ||
    family === 'professional_profile' ||
    family === 'public_website' ||
    family === 'social' ||
    family === 'directory'
  ) {
    return 'C';
  }

  return 'D';
};

const addObservation = (
  observations: SourceObservation[],
  observation: Omit<SourceObservation, 'sourceFamily' | 'authorityTier'> & {
    sourceKind?: ContactEvidence['sourceKind'];
    officialWebsite?: boolean;
  },
) => {
  const sourceFamily = sourceFamilyFor(observation);
  observations.push({
    sourceUrl: observation.sourceUrl,
    sourceName: observation.sourceName,
    sourceFamily,
    authorityTier: authorityTierFor(sourceFamily),
    observedAt: observation.observedAt,
  });
};

export const collectLeadSourceObservations = (
  lead: Lead,
  contactEvidence: ContactEvidence[] = lead.contactEvidence ?? [],
): SourceObservation[] => {
  const observations: SourceObservation[] = [];
  const safeContactEvidence = Array.isArray(contactEvidence)
    ? contactEvidence.filter((contact): contact is ContactEvidence => Boolean(
        contact &&
          typeof contact === 'object' &&
          typeof contact.sourceUrl === 'string' &&
          typeof contact.sourceName === 'string',
      ))
    : [];
  const officialWebsite = ['confirmed', 'probable'].includes(lead.websiteAssessment?.status ?? '');

  if (lead.listingUrl && isPublicHttpUrl(lead.listingUrl)) {
    addObservation(observations, {
      sourceUrl: lead.listingUrl,
      sourceName: lead.source || 'Public listing',
      observedAt: lead.scrapedAt,
    });
  }

  if (lead.website && isPublicHttpUrl(lead.website)) {
    addObservation(observations, {
      sourceUrl: lead.website,
      sourceName: 'Official business website',
      officialWebsite,
      observedAt: lead.websiteAssessment?.observedAt ?? lead.scrapedAt,
    });
  }

  if (lead.contactSourceUrl && isPublicHttpUrl(lead.contactSourceUrl)) {
    addObservation(observations, {
      sourceUrl: lead.contactSourceUrl,
      sourceName: 'Public contact source',
      officialWebsite,
      observedAt: lead.scrapedAt,
    });
  }

  for (const contact of safeContactEvidence) {
    addObservation(observations, {
      sourceUrl: contact.sourceUrl,
      sourceName: contact.sourceName,
      sourceKind: contact.sourceKind,
      officialWebsite:
        officialWebsite && samePublicHost(contact.sourceUrl, lead.website)
          ? true
          : undefined,
      observedAt: contact.observedAt ?? lead.scrapedAt,
    });
  }

  const safeEvidence = Array.isArray(lead.evidence)
    ? lead.evidence.filter((evidence) => Boolean(
        evidence &&
          typeof evidence === 'object' &&
          typeof evidence.sourceUrl === 'string' &&
          typeof evidence.sourceName === 'string',
      ))
    : [];
  for (const evidence of safeEvidence) {
    if (evidence.status === 'rejected' || !isPublicHttpUrl(evidence.sourceUrl)) continue;

    addObservation(observations, {
      sourceUrl: evidence.sourceUrl,
      sourceName: evidence.sourceName,
      observedAt: evidence.observedAt ?? lead.scrapedAt,
    });
  }

  if (lead.publicEvidence?.profileTitle || lead.publicEvidence?.profileSnippet || lead.publicEvidence?.sources?.length) {
    addObservation(observations, {
      sourceName: 'Public search result evidence',
      sourceKind: 'public_snippet',
      observedAt: lead.scrapedAt,
    });
  }

  return observations;
};

export const getIndependentSourceFamilies = (observations: SourceObservation[]) => [
  ...new Set(observations.map((observation) => observation.sourceFamily)),
];

export const getStrongestAuthorityTier = (
  observations: SourceObservation[],
): EvidenceAuthorityTier => {
  const rank: Record<EvidenceAuthorityTier, number> = { A: 4, B: 3, C: 2, D: 1 };
  return observations.reduce<EvidenceAuthorityTier>(
    (strongest, observation) =>
      rank[observation.authorityTier] > rank[strongest]
        ? observation.authorityTier
        : strongest,
    'D',
  );
};

export const sourceFamilyForEvidence = sourceFamilyFor;
