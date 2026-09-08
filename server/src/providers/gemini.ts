import axios from 'axios';

import type { ResearchCandidate } from '../types/lead';
import type { SearchRequest } from '../types/search';
import { isPublicHttpUrl } from '../utils/public-url';

const geminiQueryModel = (process.env.GEMINI_QUERY_MODEL?.trim() || 'gemini-2.5-flash').replace(
  /^models\//,
  '',
);
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiQueryModel)}:generateContent`;
const MAX_QUERY_HINTS = 8;
const MAX_RESEARCH_CANDIDATES = 120;

const parsedGeminiTimeoutMs = Number(process.env.GEMINI_QUERY_TIMEOUT_MS ?? 5_500);
const geminiTimeoutMs = Number.isFinite(parsedGeminiTimeoutMs)
  ? Math.min(7_000, Math.max(1_500, Math.round(parsedGeminiTimeoutMs)))
  : 5_500;

const parsedLeadDiscoveryTimeoutMs = Number(process.env.GEMINI_LEAD_DISCOVERY_TIMEOUT_MS ?? 12_000);
const geminiLeadDiscoveryTimeoutMs = Number.isFinite(parsedLeadDiscoveryTimeoutMs)
  ? Math.min(15_000, Math.max(3_000, Math.round(parsedLeadDiscoveryTimeoutMs)))
  : 12_000;

const isExplicitlyDisabled = (name: string) =>
  process.env[name]?.trim().toLowerCase() === 'false';

/** A configured key enables the free/public Gemini layer unless explicitly disabled. */
export const isGeminiQueryAssistanceEnabled = () =>
  Boolean(process.env.GEMINI_API_KEY?.trim()) &&
  !isExplicitlyDisabled('GEMINI_QUERY_ASSISTANCE_ENABLED');

/** Grounded public-web candidate discovery is AI mode's lead-recall layer. */
export const isGeminiLeadDiscoveryEnabled = () =>
  isGeminiQueryAssistanceEnabled() && !isExplicitlyDisabled('GEMINI_LEAD_DISCOVERY_ENABLED');

const readString = (value: unknown, maxLength: number) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const readStringArray = (value: unknown, maxItems: number, maxLength: number) => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => readString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
};

const dedupeStrings = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

const modelText = (data: unknown) => {
  const candidate = (data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  })?.candidates?.[0];

  return candidate?.content?.parts
    ?.map((part) => readString(part.text, 20_000))
    .filter(Boolean)
    .join('\n')
    .trim() ?? '';
};

const parseJsonValue = (text: string): unknown => {
  const candidates = [
    text.trim(),
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim() ?? '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // The model occasionally prefixes valid JSON with a short explanation.
    }
  }

  const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0);
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (!Number.isFinite(start) || start < 0 || end <= start) return undefined;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

const normalizeHint = (value: string) =>
  value
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '')
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);

/** Accept strict JSON first, then tolerate line-oriented model output. */
export const normalizeGeminiQueryHints = (value: unknown, fallback: string[] = []) => {
  const rawText = typeof value === 'string' ? value : '';
  const parsed = rawText ? parseJsonValue(rawText) : value;
  const parsedHints = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as { queries?: unknown; searchQueries?: unknown }).queries ??
        (parsed as { searchQueries?: unknown }).searchQueries ??
        []
      : [];
  const parsedStructured = Array.isArray(parsed) || Boolean(parsed && typeof parsed === 'object');
  const lineHints = parsed === undefined || !parsedStructured
    ? rawText
        .split(/[\n;]+/u)
        .map(normalizeHint)
        .filter(Boolean)
    : [];
  const hints = [...readStringArray(parsedHints, MAX_QUERY_HINTS, 180), ...lineHints]
    .map(normalizeHint)
    .filter(Boolean);

  return dedupeStrings([...hints, ...fallback.map(normalizeHint)]).slice(0, MAX_QUERY_HINTS);
};

const normalizePublicSourceUrl = (value: unknown) => {
  const candidate = readString(value, 2_048);
  if (!candidate || !isPublicHttpUrl(candidate)) return '';

  try {
    const url = new URL(candidate);
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
};

const inferPublicLinkPlatform = (url: string) => {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
    const knownPlatforms: Record<string, string> = {
      'facebook.com': 'Facebook',
      'instagram.com': 'Instagram',
      'linkedin.com': 'LinkedIn',
      'tiktok.com': 'TikTok',
      'x.com': 'X',
      'twitter.com': 'X',
      'youtube.com': 'YouTube',
      'yelp.com': 'Yelp',
      'google.com': 'Google Business',
    };
    return knownPlatforms[host] ?? host;
  } catch {
    return 'Other';
  }
};

const readPublicSocialLinks = (value: unknown) => {
  if (!Array.isArray(value)) return [] as Array<{ platform: string; url: string }>;

  const links = value
    .map((item) => {
      if (typeof item === 'string') {
        const url = normalizePublicSourceUrl(item);
        return url ? { platform: inferPublicLinkPlatform(url), url } : undefined;
      }

      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const url = normalizePublicSourceUrl(record.url ?? record.link ?? record.profileUrl);
      const platform = readString(record.platform ?? record.name ?? record.type, 80);
      return url ? { platform: platform || inferPublicLinkPlatform(url), url } : undefined;
    })
    .filter((link): link is { platform: string; url: string } => Boolean(link));

  return [...new Map(links.map((link) => [link.url, link])).values()].slice(0, 12);
};

type PublicSourceEntry = {
  url: string;
  title?: string;
};

const readPublicSourceEntries = (value: unknown): PublicSourceEntry[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === 'string') {
        const url = normalizePublicSourceUrl(item);
        return url ? { url } : undefined;
      }

      if (!item || typeof item !== 'object') return undefined;
      const record = item as Record<string, unknown>;
      const url = normalizePublicSourceUrl(record.url ?? record.link ?? record.sourceUrl);
      const title = readString(record.title ?? record.name, 240);
      return url ? { url, ...(title ? { title } : {}) } : undefined;
    })
    .filter((entry): entry is PublicSourceEntry => Boolean(entry))
    .slice(0, 12);
};

const publicSourceKey = (value: string) => {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/u, '').toLowerCase() || '/';
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return value.trim().toLowerCase();
  }
};

export type GroundingSource = {
  url: string;
  title?: string;
};

const readGroundingSources = (data: unknown): GroundingSource[] => {
  const groundingChunks = (data as {
    candidates?: Array<{
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }> };
    }>;
  })?.candidates?.[0]?.groundingMetadata?.groundingChunks;

  const sources = (groundingChunks ?? [])
    .map((chunk) => ({
      url: normalizePublicSourceUrl(chunk.web?.uri),
      title: readString(chunk.web?.title, 240),
    }))
    .filter((source) => Boolean(source.url));

  const unique = new Map<string, GroundingSource>();
  for (const source of sources) {
    if (!unique.has(source.url)) unique.set(source.url, source);
  }
  return [...unique.values()];
};

const getCandidateRecords = (value: unknown) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];

  const object = value as { candidates?: unknown; leads?: unknown; results?: unknown };
  if (Array.isArray(object.candidates)) return object.candidates;
  if (Array.isArray(object.leads)) return object.leads;
  if (Array.isArray(object.results)) return object.results;
  return [];
};

export type GeminiLeadDiscoveryResult = {
  candidates: ResearchCandidate[];
  groundingSources: GroundingSource[];
};

/**
 * Parse only candidates returned alongside Google Search grounding metadata.
 * Model-reported details are retained for review, but never promoted to
 * validated lead contact fields here.
 */
export const parseGroundedGeminiCandidates = (
  data: unknown,
  discoveredAt = new Date().toISOString(),
): GeminiLeadDiscoveryResult => {
  const text = modelText(data);
  const parsed = parseJsonValue(text);
  const groundingSources = readGroundingSources(data);
  const groundingUrls = new Set(groundingSources.map((source) => publicSourceKey(source.url)));
  const records = getCandidateRecords(parsed);
  const candidates: ResearchCandidate[] = [];

  records.slice(0, MAX_RESEARCH_CANDIDATES).forEach((record, index) => {
    if (!record || typeof record !== 'object') return;
    const item = record as Record<string, unknown>;
    const name = readString(item.name ?? item.personName, 180);
    const organizationName = readString(item.organizationName ?? item.organization ?? item.company, 220);
    const originalRole = readString(item.role ?? item.title ?? item.position, 180);
    const location = readString(item.location ?? item.city, 180);
    const website = normalizePublicSourceUrl(item.website ?? item.companyWebsite);
    const profileUrl = normalizePublicSourceUrl(item.profileUrl ?? item.linkedinUrl ?? item.profile);
    const socialLinks = readPublicSocialLinks(item.socialLinks ?? item.socialProfiles ?? item.social);
    const modelSourceEntries = readPublicSourceEntries(item.sourceUrls ?? item.sources ?? item.source);
    const sourceUrls = dedupeStrings(
      [
        ...modelSourceEntries.map((entry) => entry.url),
        website,
        profileUrl,
        ...socialLinks.map((link) => link.url),
      ].filter(Boolean),
    );
    const groundedSourceUrls = sourceUrls.filter((url) => groundingUrls.has(publicSourceKey(url)));
    const sourceTitles = dedupeStrings([
      ...readStringArray(item.sourceTitles, 12, 240),
      ...modelSourceEntries.map((entry) => entry.title ?? ''),
      ...groundingSources
        .filter((source) => groundingUrls.has(publicSourceKey(source.url)) && groundedSourceUrls.some(
          (url) => publicSourceKey(url) === publicSourceKey(source.url),
        ))
        .map((source) => source.title ?? ''),
    ]).slice(0, 12);
    const evidence = readString(item.evidence ?? item.summary ?? item.details, 1_000);
    const reportedPhone = readString(item.phone ?? item.mobile ?? item.phoneNumber, 80);
    const reportedEmail = readString(item.email ?? item.emailAddress, 240);

    if (
      !name &&
      !organizationName &&
      !originalRole &&
      !location &&
      !website &&
      !profileUrl &&
      !socialLinks.length &&
      !sourceUrls.length &&
      !evidence &&
      !reportedPhone &&
      !reportedEmail
    ) {
      return;
    }

    const grounded = groundedSourceUrls.length > 0;
    candidates.push({
      id: `gemini-research-${index + 1}-${Buffer.from(
        `${name}|${organizationName}|${profileUrl}|${website}`,
      )
        .toString('base64url')
        .slice(0, 24)}`,
      ...(name ? { name } : {}),
      ...(organizationName ? { organizationName } : {}),
      ...(originalRole ? { originalRole } : {}),
      ...(location ? { location } : {}),
      ...(website ? { website } : {}),
      ...(profileUrl ? { profileUrl } : {}),
      ...(reportedPhone ? { reportedPhone } : {}),
      ...(reportedEmail ? { reportedEmail } : {}),
      ...(socialLinks.length ? { socialLinks } : {}),
      sourceUrls,
      ...(sourceTitles.length ? { sourceTitles } : {}),
      ...(evidence ? { evidence } : {}),
      grounded,
      status: grounded ? 'needs_phone_validation' : 'needs_source_review',
      discoveredAt,
    });
  });

  return { candidates, groundingSources };
};

const geminiRequest = async (body: Record<string, unknown>, timeout: number) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  return axios.post(GEMINI_ENDPOINT, body, {
    timeout,
    headers: {
      // Keep the key out of request URLs, logs, and proxy cache keys.
      'x-goog-api-key': apiKey,
    },
  });
};

export const expandQueryWithGemini = async (
  rawQuery: string,
  request: SearchRequest,
): Promise<string[]> => {
  if (!isGeminiQueryAssistanceEnabled()) return [];

  const response = await geminiRequest(
    {
      contents: [
        {
          parts: [
            {
              text: `Build up to ${MAX_QUERY_HINTS} distinct public-web search lenses for finding United States business decision-makers. Cover category synonyms and service names, city/metro/state phrasing, owner/founder/CEO/operator roles, official company sites, public professional profiles, trade associations, licensing directories, and public business listings. Return JSON only as an array of short search phrases. Never request personal contact data, private profiles, logins, paywalls, Premium data, or bypass instructions. Do not invent names, companies, phone numbers, emails, or URLs.\nCategory: ${request.companyType}\nLocation: ${request.city}\nResearch brief: ${request.researchBrief?.trim() || 'No additional brief'}\nBase query: ${rawQuery}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
      },
    },
    geminiTimeoutMs,
  );

  return normalizeGeminiQueryHints(modelText(response.data));
};

export const discoverLeadsWithGemini = async (
  request: SearchRequest,
  locationLabel: string,
): Promise<GeminiLeadDiscoveryResult> => {
  if (!isGeminiLeadDiscoveryEnabled()) return { candidates: [], groundingSources: [] };

  const response = await geminiRequest(
    {
      contents: [
        {
          parts: [
            {
              text: `Use Google Search to find public, current US business lead candidates for this request. Search broadly across official company websites, public professional profile pages, trade associations, licensing or registry pages, news, public social links, and reputable business directories. Return JSON only with a candidates array, up to 40 records. Each record may include: name, organizationName, role, location, website, profileUrl, phone, email, sourceUrls, sourceTitles, evidence. Include only details actually visible in public search results or the cited page. Phone and email must be publicly listed business contact details, never guessed or inferred. Do not use private/authenticated profiles, Sales Navigator/Premium, paywalled pages, contact-reveal services, commercial lead databases, login sessions, or bypasses. Keep former or conflicting roles marked in evidence instead of presenting them as current. Always include sourceUrls for the pages that support the record; never fabricate a URL.\nCompany type: ${request.companyType}\nTarget location: ${locationLabel}\nResearch brief: ${request.researchBrief?.trim() || 'Find owner-led businesses and their publicly evidenced decision-makers.'}`,
            },
          ],
        },
      ],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 6_000,
      },
    },
    geminiLeadDiscoveryTimeoutMs,
  );

  return parseGroundedGeminiCandidates(response.data);
};
