import type { Lead, ResearchCandidate } from '../types/lead';
import {
  discoverLeadsWithGemini,
  type GeminiLeadDiscoveryResult,
} from '../providers/gemini';
import type { SearchRequest } from '../types/search';

export type GeminiResearchDiscovery = GeminiLeadDiscoveryResult & {
  leads: Lead[];
};

const decisionMakerRole = /\b(owner|founder|co[- ]?founder|chief|ceo|president|partner|principal|director|manager|operator|practice administrator|general manager|managing member)\b/i;

const titleForCandidate = (candidate: ResearchCandidate) =>
  [candidate.name, candidate.originalRole, candidate.organizationName]
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

  const name = candidate.name || candidate.organizationName;
  if (!name) return undefined;

  const now = candidate.discoveredAt || new Date().toISOString();
  const sourceTitles = candidate.sourceTitles ?? [];
  const sourceName = 'Gemini, Grounded Public Search';

  return {
    id: `gemini-lead-${index + 1}-${candidate.id.slice(-16)}`,
    name,
    ...(candidate.originalRole ? { originalRole: candidate.originalRole } : {}),
    ...(candidate.organizationName ? { organizationName: candidate.organizationName } : {}),
    ...(candidate.originalRole
      ? { decisionMaker: decisionMakerRole.test(candidate.originalRole) }
      : {}),
    employmentStatus: 'unverified',
    mobile: '',
    email: '',
    ...(candidate.website ? { website: candidate.website } : {}),
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
): Promise<GeminiResearchDiscovery> => {
  const result = await discoverLeadsWithGemini(request, locationLabel);
  return {
    ...result,
    leads: buildLeadsFromGeminiCandidates(result.candidates, request, locationLabel),
  };
};
