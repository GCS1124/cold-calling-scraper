import { createHash } from 'node:crypto';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';
import type { NormalizedUsLocation } from './us-location';
import { buildDiscoverySeeds } from './discovery-seeds';
import { resolveCategoryProfile } from './us-category-mapping';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type LinkedInCandidate = {
  title: string;
  name: string;
  headline?: string;
  profileUrl: string;
  snippet: string;
};

export type LinkedInDiscoveryResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  blocked: boolean;
};

const maxQueries = 4;
const searchTimeoutMs = 4500;
const sourceLabel = 'LinkedIn';
const providerId = 'linkedin-search';

const blockedBodyPatterns = [
  /captcha/i,
  /challenge/i,
  /too many requests/i,
  /unusual traffic/i,
  /verify.*not a bot/i,
  /we detected unusual traffic/i,
  /access denied/i,
  /temporarily blocked/i,
  /forbidden/i,
  /robot/i,
];

const searchSources = [
  {
    name: 'brave',
    label: 'Brave Search',
    buildUrl: (query: string) =>
      `https://r.jina.ai/http://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
    decodeUrl: (value: string) => value,
  },
  {
    name: 'bing',
    label: 'Bing',
    buildUrl: (query: string) =>
      `https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(query)}`,
    decodeUrl: (value: string) => decodeBingUrl(value),
  },
] as const;

const normalizeText = (value?: string | null) =>
  (value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );

const stripMarkdown = (value: string) =>
  decodeHtmlEntities(
    value
      .replace(/!\[[^\]]*\]\((?:[^)]+)\)/g, ' ')
      .replace(/\[([^\]]*?)\]\((https?:\/\/[^)]+)\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .trim(),
  );

const extractUrls = (value: string) => Array.from(value.matchAll(/https?:\/\/[^\s<>"')\]]+/gi), (match) => match[0]);

const decodeBingUrl = (value: string) => {
  try {
    const url = value.startsWith('//') ? new URL(`https:${value}`) : new URL(value);
    const encoded = url.searchParams.get('u');
    if (!encoded) {
      return value;
    }

    const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded;
    return Buffer.from(payload, 'base64').toString('utf8');
  } catch {
    return value;
  }
};

const createId = (value: string) =>
  `linkedin-${createHash('sha1').update(value).digest('hex')}`;

const unique = (values: string[]) => [...new Set(values.map(normalizeText).filter(Boolean))];

const normalizeQueryTerm = (value: string) =>
  normalizeText(value)
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s*["'’`]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeLinkedInProfileUrl = (value?: string) => {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!url.hostname.endsWith('linkedin.com')) {
      return null;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0]?.toLowerCase() !== 'in' || !segments[1]) {
      return null;
    }

    const slug = segments[1].trim().toLowerCase();
    if (!slug) {
      return null;
    }

    return `https://linkedin.com/in/${slug}`;
  } catch {
    return null;
  }
};

const isLinkedInProfileUrl = (value: string) => Boolean(normalizeLinkedInProfileUrl(value));

const slugToName = (value?: string) => {
  const normalized = normalizeLinkedInProfileUrl(value);
  if (!normalized) {
    return '';
  }

  const slug = normalized.split('/in/')[1]?.split(/[/?#]/)[0] ?? '';

  return slug
    .split('-')
    .map((part) => part.trim())
    .filter((part) => part && !/^\d+$/.test(part) && part.toLowerCase() !== 'profile')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .trim();
};

const hasLinkedInProfileSignals = (value: string) =>
  /linkedin|professional profile|profile on linkedin|connections:|followers:|works for:|experience:/i.test(
    value,
  );

const buildQueryVariants = (request: SearchRequest, location: NormalizedUsLocation) => {
  const profile = resolveCategoryProfile(request.companyType);
  const companyTerms = unique([
    request.companyType,
    profile.searchTerms[0] ?? request.companyType,
    profile.searchTerms[1] ?? request.companyType,
    profile.searchTerms[2] ?? request.companyType,
  ]).slice(0, 3);
  const locationTerms = unique([
    normalizeQueryTerm(location.label),
    normalizeQueryTerm(location.city || location.label),
    ...buildDiscoverySeeds(location).slice(0, 3).map(normalizeQueryTerm),
  ]).slice(0, 3);
  const roleTerms = [
    'founder',
    'owner',
    'ceo',
    'principal',
    'partner',
    'director',
  ];

  const primaryCompany = companyTerms[0] ?? normalizeQueryTerm(request.companyType);
  const secondaryCompany = companyTerms[1] ?? primaryCompany;
  const primaryLocation = locationTerms[0] ?? normalizeQueryTerm(location.label);
  const secondaryLocation = locationTerms[1] ?? primaryLocation;

  return unique([
    `site:linkedin.com/in/ ${roleTerms[0]} ${primaryCompany} ${primaryLocation} -jobs -company -school -posts -learning`,
    `site:linkedin.com/in/ ${roleTerms[1]} ${primaryCompany} ${primaryLocation} -jobs -company -school -posts -learning`,
    `site:linkedin.com/in/ ${roleTerms[2]} ${primaryCompany} ${primaryLocation} -jobs -company -school -posts -learning`,
    `site:linkedin.com/in/ ${roleTerms[3]} ${secondaryCompany} ${primaryLocation} -jobs -company -school -posts -learning`,
    `site:linkedin.com/in/ ${roleTerms[4]} ${secondaryCompany} ${primaryLocation} -jobs -company -school -posts -learning`,
    `site:linkedin.com/in/ ${roleTerms[5]} ${primaryCompany} ${secondaryLocation} -jobs -company -school -posts -learning`,
    `site:linkedin.com/in/ ${roleTerms[6]} ${primaryCompany} ${secondaryLocation} -jobs -company -school -posts -learning`,
    `site:linkedin.com/in/ ${roleTerms[7]} ${secondaryCompany} ${secondaryLocation} -jobs -company -school -posts -learning`,
  ]).slice(0, maxQueries);
};

const fetchTextWithTimeout = async (url: string, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/plain, text/markdown, text/html;q=0.9, */*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`Search request failed with status ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
};

const isBlockedSearchBody = (body: string) => blockedBodyPatterns.some((pattern) => pattern.test(body));

const buildBlockedWarning = (sourceLabelText: string, query: string) => ({
  providerId: `${providerId}-${sourceLabelText.toLowerCase().replace(/\s+/g, '-')}`,
  providerName: sourceLabelText,
  message: `${sourceLabelText} returned a blocked or rate-limited page while searching public LinkedIn profiles for "${query}".`,
});

const buildFetchWarning = (sourceLabelText: string, query: string, error: unknown) => ({
  providerId: `${providerId}-${sourceLabelText.toLowerCase().replace(/\s+/g, '-')}`,
  providerName: sourceLabelText,
  message:
    error instanceof Error
      ? `${sourceLabelText} search failed for "${query}": ${error.message}`
      : `${sourceLabelText} search failed while searching public LinkedIn profiles for "${query}".`,
});

const parseMarkdownResults = (markdown: string, decodeUrl: (value: string) => string) => {
  const results: SearchResult[] = [];
  const lines = markdown.split(/\r?\n/);
  let current: SearchResult | null = null;

  const flush = () => {
    if (current) {
      results.push({
        ...current,
        snippet: normalizeText(current.snippet),
      });
    }

    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (current?.snippet) {
        current.snippet += ' ';
      }
      continue;
    }

    if (
      line.startsWith('Title:') ||
      line.startsWith('URL Source:') ||
      line === 'Markdown Content:' ||
      line.startsWith('About this page') ||
      line.startsWith('Only showing results from')
    ) {
      continue;
    }

    const urls = extractUrls(line).map((url) => decodeUrl(url));
    const profileUrl = urls.map(normalizeLinkedInProfileUrl).find(Boolean);
    const visibleText = stripMarkdown(line);

    if (profileUrl) {
      flush();
      current = {
        title: visibleText,
        url: profileUrl,
        snippet: '',
      };
      continue;
    }

    if (!current) {
      continue;
    }

    current.snippet = `${current.snippet} ${visibleText}`.trim();
  }

  flush();
  return results;
};

const searchProvider = async (source: (typeof searchSources)[number], query: string) => {
  try {
    const markdown = await fetchTextWithTimeout(source.buildUrl(query), searchTimeoutMs);
    if (isBlockedSearchBody(markdown)) {
      return {
        results: [] as SearchResult[],
        warnings: [buildBlockedWarning(source.label, query)],
        blocked: true,
      };
    }

    return {
      results: parseMarkdownResults(markdown, source.decodeUrl).filter((result) =>
        isLinkedInProfileUrl(result.url),
      ),
      warnings: [] as ProviderWarning[],
      blocked: false,
    };
  } catch (error) {
    return {
      results: [] as SearchResult[],
      warnings: [buildFetchWarning(source.label, query, error)],
      blocked: true,
    };
  }
};

const collectSearchResults = async (query: string, remainingResults: number) => {
  const warnings: ProviderWarning[] = [];
  const [brave, bing] = await Promise.all(
    searchSources.map((source) => searchProvider(source, query)),
  );
  const collected: SearchResult[] = [];
  const seenUrls = new Set<string>();
  let blocked = false;

  for (const resultSet of [brave, bing]) {
    warnings.push(...resultSet.warnings);
    blocked ||= resultSet.blocked;

    for (const result of resultSet.results) {
      if (collected.length >= remainingResults) {
        break;
      }

      if (seenUrls.has(result.url)) {
        continue;
      }

      seenUrls.add(result.url);
      collected.push(result);
    }
  }

  return {
    results: collected,
    warnings,
    blocked,
  };
};

const parseLinkedInTitle = (title: string, profileUrl: string) => {
  const cleaned = normalizeText(
    decodeHtmlEntities(title)
      .replace(/^(?:LinkedIn\s+)?linkedin\.com\s*›\s*in\s*›\s*[^ ]+\s+/i, '')
      .replace(/\s*[|]\s*Professional Profile\s*[|]\s*LinkedIn.*$/i, '')
      .replace(/\s*[|]\s*LinkedIn.*$/i, '')
      .replace(/\s*-\s*LinkedIn.*$/i, ''),
  );

  const viewMatch = cleaned.match(/^View\s+(.+?)\s+(?:[’']s)?\s*profile on LinkedIn$/i);
  if (viewMatch?.[1]) {
    return {
      name: normalizeText(viewMatch[1]),
      headline: undefined,
    };
  }

  const segments = cleaned
    .split(/\s+[–—-]\s+/)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);

  const name = segments[0] ?? slugToName(profileUrl) ?? cleaned;
  const headline = normalizeText(segments.slice(1).join(' - '));

  return {
    name,
    headline: headline || undefined,
  };
};

const toLeadConfidence = (candidate: LinkedInCandidate) => {
  let score = 66;

  if (candidate.name) score += 10;
  if (candidate.headline) score += 8;
  if (candidate.snippet) score += 4;
  if (candidate.profileUrl.includes('/in/')) score += 10;
  if (hasLinkedInProfileSignals(candidate.title)) score += 5;
  if (hasLinkedInProfileSignals(candidate.snippet)) score += 3;

  return Math.min(score, 95);
};

const buildLeadFromCandidate = (
  candidate: LinkedInCandidate,
  request: SearchRequest,
  location: NormalizedUsLocation,
): Lead => ({
  id: createId(candidate.profileUrl || `${candidate.name}-${candidate.headline ?? ''}`),
  name: normalizeText(candidate.name || slugToName(candidate.profileUrl) || candidate.profileUrl),
  mobile: '',
  email: '',
  website: '',
  address: '',
  category: request.companyType,
  city: location.label,
  source: sourceLabel,
  confidence: toLeadConfidence(candidate),
  sourceScore: 86,
  listingUrl: candidate.profileUrl,
  hasEmail: false,
  hasPhone: false,
  hasWebsite: false,
  verifiedPhone: false,
  verifiedEmail: false,
  scrapedAt: new Date().toISOString(),
});

const buildNoResultsWarning = (locationLabel: string) => ({
  providerId,
  providerName: sourceLabel,
  message: `No public LinkedIn profiles were returned for ${locationLabel}.`,
});

const pushUniqueWarning = (warnings: ProviderWarning[], warning: ProviderWarning) => {
  if (
    warnings.some(
      (entry) => entry.providerId === warning.providerId && entry.message === warning.message,
    )
  ) {
    return;
  }

  warnings.push(warning);
};

export const discoverUsLeadsFromLinkedinSearch = async ({
  request,
  location,
  deadlineMs,
}: {
  request: SearchRequest;
  location: NormalizedUsLocation;
  deadlineMs?: number;
}): Promise<LinkedInDiscoveryResult> => {
  const start = Date.now();
  const deadline = deadlineMs ?? start + 28_000;
  const queries = buildQueryVariants(request, location);
  const maxResults = Number(process.env.LINKEDIN_SEARCH_MAX_RESULTS ?? request.count);
  const candidates = new Map<string, LinkedInCandidate>();
  const warnings: ProviderWarning[] = [];
  let blocked = false;

  for (const query of queries) {
    if (Date.now() >= deadline || candidates.size >= maxResults) {
      break;
    }

    const queryResults = await collectSearchResults(query, maxResults - candidates.size);
    blocked ||= queryResults.blocked;
    queryResults.warnings.forEach((warning) => pushUniqueWarning(warnings, warning));

    for (const result of queryResults.results) {
      if (Date.now() >= deadline || candidates.size >= maxResults) {
        break;
      }

      const profileUrl = normalizeLinkedInProfileUrl(result.url);
      if (!profileUrl || candidates.has(profileUrl)) {
        continue;
      }

      const { name, headline } = parseLinkedInTitle(result.title, profileUrl);

      candidates.set(profileUrl, {
        title: result.title,
        name,
        headline,
        profileUrl,
        snippet: normalizeText(result.snippet),
      });
    }
  }

  const leads = [...candidates.values()].map((candidate) =>
    buildLeadFromCandidate(candidate, request, location),
  );

  if (!leads.length && !warnings.length) {
    warnings.push(buildNoResultsWarning(location.label));
  }

  return {
    leads,
    warnings,
    blocked,
  };
};

export const buildLinkedinSearchWarning = buildNoResultsWarning;
