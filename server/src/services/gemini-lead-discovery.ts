import type { Lead, PublicSocialLink, ResearchCandidate } from '../types/lead';
import {
  discoverLeadsWithGemini,
  type GeminiLeadDiscoveryResult,
} from '../providers/gemini';
import type { SearchRequest } from '../types/search';
import { isPublicHttpUrl } from '../utils/public-url';

export type GeminiResearchDiscovery = GeminiLeadDiscoveryResult & {
  leads: Lead[];
};

const asString = (value: unknown) => (typeof value === 'string' ? value : '');

const normalizeIdentityPart = (value?: unknown) =>
  asString(value)
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

const uniqueStrings = (values: unknown[]) => [
  ...new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];

const mergeResearchCandidate = (
  current: ResearchCandidate,
  incoming: ResearchCandidate,
): ResearchCandidate => {
  const grounded = current.grounded || incoming.grounded;
  const evidence = uniqueStrings([current.evidence, incoming.evidence]).join(' | ');
  const sourceUrls = uniqueStrings([
    ...(Array.isArray(current.sourceUrls) ? current.sourceUrls : []),
    ...(Array.isArray(incoming.sourceUrls) ? incoming.sourceUrls : []),
  ]).filter(isPublicHttpUrl).slice(0, 12);
  const socialLinks = [
    ...(Array.isArray(current.socialLinks) ? current.socialLinks : []),
    ...(Array.isArray(incoming.socialLinks) ? incoming.socialLinks : []),
  ].filter(
    (link, index, links) => Boolean(
      link &&
        typeof link === 'object' &&
        typeof link.url === 'string' &&
        isPublicHttpUrl(link.url) &&
        links.findIndex((candidate) => candidate?.url === link.url) === index,
    ),
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
    sourceUrls,
    sourceTitles: uniqueStrings([
      ...(Array.isArray(current.sourceTitles) ? current.sourceTitles : []),
      ...(Array.isArray(incoming.sourceTitles) ? incoming.sourceTitles : []),
    ]).slice(0, 12),
    socialLinks: socialLinks.length ? socialLinks.slice(0, 12) : undefined,
    evidence: evidence ? evidence.slice(0, 2_000) : undefined,
    grounded: grounded && sourceUrls.length > 0,
    status: grounded && sourceUrls.length > 0 ? 'needs_phone_validation' : 'needs_source_review',
  };
};

/** Merge overlapping Gemini passes without dropping fields from either pass. */
export const mergeResearchCandidates = (candidates: ResearchCandidate[]) => {
  const merged = new Map<string, ResearchCandidate>();

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.id !== 'string') continue;
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

  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source.url !== 'string' || !isPublicHttpUrl(source.url)) continue;
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
  const links = (Array.isArray(candidate.socialLinks) ? candidate.socialLinks : [])
    .map((link) => {
      if (!link || typeof link !== 'object' || typeof link.url !== 'string' || typeof link.platform !== 'string') {
        return undefined;
      }
      const url = link.url.trim();
      const platform = supportedSocialPlatforms.get(link.platform.trim().toLowerCase());

      return url && platform && isPublicHttpUrl(url) ? { platform, url } : undefined;
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
  if (!candidate || typeof candidate !== 'object') return undefined;
  // Ungrounded records remain visible as research candidates but cannot enter
  // the lead pipeline because their identity has no attributable web source.
  const sourceUrls = (Array.isArray(candidate.sourceUrls) ? candidate.sourceUrls : [])
    .filter((sourceUrl): sourceUrl is string => typeof sourceUrl === 'string' && isPublicHttpUrl(sourceUrl))
    .slice(0, 12);
  if (candidate.grounded !== true || !sourceUrls.length || !asString(candidate.id).trim()) return undefined;

  const candidateName = asString(candidate.name);
  const candidateOrganizationName = asString(candidate.organizationName);
  const candidatePersonName = asString(candidate.personName);
  const originalRole = asString(candidate.originalRole);
  const candidateLocation = asString(candidate.location);
  const websiteCandidate = asString(candidate.website);
  const website = isPublicHttpUrl(websiteCandidate) ? websiteCandidate : '';
  const profileCandidate = asString(candidate.profileUrl);
  const profileUrl = isPublicHttpUrl(profileCandidate) ? profileCandidate : '';
  const name = candidateName || candidateOrganizationName || candidatePersonName;
  if (!name) return undefined;
  const decisionMakerName = candidatePersonName || (
    candidateOrganizationName &&
    candidateName &&
    candidateName !== candidateOrganizationName
      ? candidateName
      : undefined
  );
  const decisionMakerSourceUrl = profileUrl || sourceUrls[0];

  const now = asString(candidate.discoveredAt) || new Date().toISOString();
  const sourceTitles = (Array.isArray(candidate.sourceTitles) ? candidate.sourceTitles : [])
    .filter((title): title is string => typeof title === 'string')
    .slice(0, 12);
  const sourceName = 'Gemini, Grounded Public Search';
  const publicSocialLinks = toPublicSocialLinks(candidate);

  return {
    id: `gemini-lead-${index + 1}-${asString(candidate.id).slice(-16)}`,
    name,
    ...(originalRole ? { originalRole } : {}),
    ...(candidateOrganizationName ? { organizationName: candidateOrganizationName } : {}),
    ...(decisionMakerName ? { decisionMakerName } : {}),
    ...(decisionMakerName && originalRole ? { decisionMakerRole: originalRole } : {}),
    ...(decisionMakerName && decisionMakerSourceUrl ? { decisionMakerSourceUrl } : {}),
    ...(originalRole
      ? { decisionMaker: decisionMakerRole.test(originalRole) }
      : {}),
    employmentStatus: 'unverified',
    mobile: '',
    email: '',
    ...(website ? { website } : {}),
    ...(publicSocialLinks.length ? { publicSocialLinks } : {}),
    address: candidateLocation || locationLabel,
    category: request.companyType,
    city: locationLabel,
    source: sourceName,
    confidence: Math.min(78, 52 + Math.min(sourceUrls.length, 4) * 5),
    sourceScore: 48,
    listingUrl: decisionMakerSourceUrl,
    publicEvidence: {
      profileTitle: titleForCandidate({
        ...candidate,
        name: candidateName,
        personName: candidatePersonName,
        organizationName: candidateOrganizationName,
        originalRole,
      }) || undefined,
      profileSnippet: asString(candidate.evidence) || undefined,
      sources: sourceUrls.map((sourceUrl, sourceIndex) => ({
        providerName: sourceName,
        profileTitle: sourceTitles[sourceIndex] || undefined,
        profileSnippet: asString(candidate.evidence) || undefined,
      })),
    },
    evidence: sourceUrls.map((sourceUrl, sourceIndex) => ({
      sourceUrl,
      sourceName: sourceTitles[sourceIndex] || sourceName,
      claim: asString(candidate.evidence) || `Public candidate reference for ${name}.`,
      status: 'unknown' as const,
      observedAt: now,
    })),
    hasEmail: false,
    hasPhone: false,
    hasWebsite: Boolean(website),
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
  (Array.isArray(candidates) ? candidates : [])
    .map((candidate, index) => toLead(candidate, request, locationLabel, index))
    .filter((lead): lead is Lead => Boolean(lead));

export const discoverGeminiResearch = async (
  request: SearchRequest,
  locationLabel: string,
  listingSeeds: Lead[] = [],
  searchLocationContext = locationLabel,
  timeoutMs?: number,
): Promise<GeminiResearchDiscovery> => {
  const result = await discoverLeadsWithGemini(
    request,
    locationLabel,
    listingSeeds,
    searchLocationContext,
    timeoutMs,
  );
  return {
    ...result,
    leads: buildLeadsFromGeminiCandidates(result.candidates, request, locationLabel),
  };
};
