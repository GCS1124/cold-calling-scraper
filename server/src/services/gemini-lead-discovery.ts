import type { Lead, PublicSocialLink, ResearchCandidate } from '../types/lead';
import {
  discoverLeadsWithGemini,
  type GeminiLeadDiscoveryResult,
} from '../providers/gemini';
import type { SearchRequest } from '../types/search';

export type GeminiResearchDiscovery = GeminiLeadDiscoveryResult & {
  leads: Lead[];
};

const normalizeIdentityPart = (value?: string) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() ?? '';

const researchCandidateKey = (candidate: ResearchCandidate) => {
  const profile = normalizeIdentityPart(candidate.profileUrl);
  if (profile) return `profile:${profile}`;

  const website = normalizeIdentityPart(candidate.website);
  if (website) return `website:${website}`;

  const name = normalizeIdentityPart(candidate.personName || candidate.name);
  const organization = normalizeIdentityPart(candidate.organizationName);
  const location = normalizeIdentityPart(candidate.location);

  if (name && organization) return `person:${name}|organization:${organization}`;
  if (organization || name) return `entity:${organization || name}|location:${location}`;

  return `id:${candidate.id}`;
};

const uniqueStrings = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

const mergeResearchCandidate = (
  current: ResearchCandidate,
  incoming: ResearchCandidate,
): ResearchCandidate => {
  const grounded = current.grounded || incoming.grounded;
  const evidence = uniqueStrings([current.evidence ?? '', incoming.evidence ?? '']).join(' | ');
  const socialLinks = [
    ...(current.socialLinks ?? []),
    ...(incoming.socialLinks ?? []),
  ].filter(
    (link, index, links) => links.findIndex((candidate) => candidate.url === link.url) === index,
  );

  return {
    ...current,
    ...incoming,
    name: current.name || incoming.name,
    personName: current.personName || incoming.personName,
    organizationName: current.organizationName || incoming.organizationName,
    originalRole: current.originalRole || incoming.originalRole,
    location: current.location || incoming.location,
    website: current.website || incoming.website,
    profileUrl: current.profileUrl || incoming.profileUrl,
    reportedPhone: current.reportedPhone || incoming.reportedPhone,
    reportedEmail: current.reportedEmail || incoming.reportedEmail,
    sourceUrls: uniqueStrings([...current.sourceUrls, ...incoming.sourceUrls]).slice(0, 12),
    sourceTitles: uniqueStrings([
      ...(current.sourceTitles ?? []),
      ...(incoming.sourceTitles ?? []),
    ]).slice(0, 12),
    ...(socialLinks.length ? { socialLinks: socialLinks.slice(0, 12) } : {}),
    ...(evidence ? { evidence: evidence.slice(0, 2_000) } : {}),
    grounded,
    status: grounded ? 'needs_phone_validation' : 'needs_source_review',
  };
};

/** Merge overlapping Gemini passes without dropping fields from either pass. */
export const mergeResearchCandidates = (candidates: ResearchCandidate[]) => {
  const merged = new Map<string, ResearchCandidate>();

  for (const candidate of candidates) {
    const key = researchCandidateKey(candidate);
    const current = merged.get(key);
    merged.set(key, current ? mergeResearchCandidate(current, candidate) : candidate);
  }

  return [...merged.values()];
};

export const mergeGroundingSources = (
  sources: GeminiResearchDiscovery['groundingSources'],
) => {
  const merged = new Map<string, GeminiResearchDiscovery['groundingSources'][number]>();

  for (const source of sources) {
    if (!merged.has(source.url)) merged.set(source.url, source);
  }

  return [...merged.values()];
};

const decisionMakerRole = /\b(owner|founder|co[- ]?founder|chief|ceo|president|partner|principal|director|manager|operator|practice administrator|general manager|managing member)\b/i;

const supportedSocialPlatforms = new Map<string, PublicSocialLink['platform']>([
  ['facebook', 'Facebook'],
  ['instagram', 'Instagram'],
  ['linkedin', 'LinkedIn'],
  ['tiktok', 'TikTok'],
  ['x', 'X'],
  ['twitter', 'X'],
  ['youtube', 'YouTube'],
  ['google business', 'Google Business'],
  ['yelp', 'Yelp'],
]);

const toPublicSocialLinks = (candidate: ResearchCandidate): PublicSocialLink[] => {
  const links = (candidate.socialLinks ?? [])
    .map((link) => {
      const url = link.url.trim();
      const platform = supportedSocialPlatforms.get(link.platform.trim().toLowerCase());

      return url && platform ? { platform, url } : undefined;
    })
    .filter((link): link is PublicSocialLink => Boolean(link));

  return [...new Map(links.map((link) => [link.url, link])).values()].slice(0, 12);
};

const titleForCandidate = (candidate: ResearchCandidate) =>
  [candidate.personName || candidate.name, candidate.originalRole, candidate.organizationName]
    .filter(Boolean)
    .join(candidate.originalRole ? ' - ' : '');

const toLead = (
  candidate: ResearchCandidate,
  request: SearchRequest,
  locationLabel: string,
  index: number,
): Lead | undefined => {
  // Ungrounded records remain visible as research candidates but cannot enter
  // the lead pipeline because their identity has no attributable web source.
  if (!candidate.grounded || !candidate.sourceUrls.length) return undefined;

  const name = candidate.name || candidate.organizationName || candidate.personName;
  if (!name) return undefined;
  const decisionMakerName = candidate.personName || (
    candidate.organizationName &&
    candidate.name &&
    candidate.name !== candidate.organizationName
      ? candidate.name
      : undefined
  );
  const decisionMakerSourceUrl = candidate.profileUrl || candidate.sourceUrls[0];

  const now = candidate.discoveredAt || new Date().toISOString();
  const sourceTitles = candidate.sourceTitles ?? [];
  const sourceName = 'Gemini, Grounded Public Search';
  const publicSocialLinks = toPublicSocialLinks(candidate);

  return {
    id: `gemini-lead-${index + 1}-${candidate.id.slice(-16)}`,
    name,
    ...(candidate.originalRole ? { originalRole: candidate.originalRole } : {}),
    ...(candidate.organizationName ? { organizationName: candidate.organizationName } : {}),
    ...(decisionMakerName ? { decisionMakerName } : {}),
    ...(decisionMakerName && candidate.originalRole ? { decisionMakerRole: candidate.originalRole } : {}),
    ...(decisionMakerName && decisionMakerSourceUrl ? { decisionMakerSourceUrl } : {}),
    ...(candidate.originalRole
      ? { decisionMaker: decisionMakerRole.test(candidate.originalRole) }
      : {}),
    employmentStatus: 'unverified',
    mobile: '',
    email: '',
    ...(candidate.website ? { website: candidate.website } : {}),
    ...(publicSocialLinks.length ? { publicSocialLinks } : {}),
    address: candidate.location || locationLabel,
    category: request.companyType,
    city: locationLabel,
    source: sourceName,
    confidence: Math.min(78, 52 + Math.min(candidate.sourceUrls.length, 4) * 5),
    sourceScore: 48,
    listingUrl: candidate.profileUrl || candidate.website || candidate.sourceUrls[0],
    publicEvidence: {
      profileTitle: titleForCandidate(candidate) || undefined,
      profileSnippet: candidate.evidence || undefined,
      sources: candidate.sourceUrls.slice(0, 12).map((sourceUrl, sourceIndex) => ({
        providerName: sourceName,
        profileTitle: sourceTitles[sourceIndex] || undefined,
        profileSnippet: candidate.evidence || undefined,
      })),
    },
    evidence: candidate.sourceUrls.slice(0, 12).map((sourceUrl, sourceIndex) => ({
      sourceUrl,
      sourceName: sourceTitles[sourceIndex] || sourceName,
      claim: candidate.evidence || `Public candidate reference for ${name}.`,
      status: 'unknown' as const,
      observedAt: now,
    })),
    hasEmail: false,
    hasPhone: false,
    hasWebsite: Boolean(candidate.website),
    verifiedPhone: false,
    verifiedEmail: false,
    scrapedAt: now,
  };
};

export const buildLeadsFromGeminiCandidates = (
  candidates: ResearchCandidate[],
  request: SearchRequest,
  locationLabel: string,
) =>
  candidates
    .map((candidate, index) => toLead(candidate, request, locationLabel, index))
    .filter((lead): lead is Lead => Boolean(lead));

export const discoverGeminiResearch = async (
  request: SearchRequest,
  locationLabel: string,
  listingSeeds: Lead[] = [],
  searchLocationContext = locationLabel,
): Promise<GeminiResearchDiscovery> => {
  const result = await discoverLeadsWithGemini(
    request,
    locationLabel,
    listingSeeds,
    searchLocationContext,
  );
  return {
    ...result,
    leads: buildLeadsFromGeminiCandidates(result.candidates, request, locationLabel),
  };
};
