import { createHash } from 'node:crypto';

import type { Lead } from '../types/lead';
import type { SearchRequest } from '../types/search';
import type { NormalizedUsLocation } from './us-location';
import { buildDiscoverySeeds } from './discovery-seeds';
import { resolveCategoryProfile } from './us-category-mapping';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type LinkedInCandidate = {
  name: string;
  headline?: string;
  profileUrl: string;
  snippet: string;
};

const maxQueries = 8;
const searchTimeoutMs = 7000;
const freeLinkedInSourceLabel = 'LinkedIn';
const providerId = 'linkedin-search';

const sourceUrls = [
  {
    name: 'duckduckgo',
    buildUrl: (query: string) =>
      `https://r.jina.ai/http://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    decodeUrl: (value: string) => decodeDuckDuckGoUrl(value),
  },
  {
    name: 'bing',
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
      .replace(/\*\*/g, '')
      .replace(/<[^>]+>/g, '')
      .trim(),
  );

const decodeDuckDuckGoUrl = (value: string) => {
  try {
    const url = value.startsWith('//') ? new URL(`https:${value}`) : new URL(value);
    const encoded = url.searchParams.get('uddg');
    if (!encoded) {
      return value;
    }

    return decodeURIComponent(encoded);
  } catch {
    return value;
  }
};

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

const isLinkedInProfileUrl = (value: string) => {
  try {
    const url = value.startsWith('http') ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.endsWith('linkedin.com') && url.pathname.startsWith('/in/');
  } catch {
    return false;
  }
};

const buildQueryVariants = (request: SearchRequest, location: NormalizedUsLocation) => {
  const profile = resolveCategoryProfile(request.companyType);
  const companyTerms = unique([
    profile.searchTerms[0] ?? request.companyType,
    request.companyType,
    ...profile.searchTerms.slice(1, 4),
  ]).slice(0, 4);
  const locationTerms = unique([
    location.label,
    ...buildDiscoverySeeds(location).slice(0, 3),
  ]).slice(0, 3);
  const primaryCompany = companyTerms[0] ?? request.companyType.trim();
  const secondaryCompany = companyTerms[1] ?? primaryCompany;
  const primaryLocation = locationTerms[0] ?? location.label;
  const secondaryLocation = locationTerms[1] ?? primaryLocation;

  return unique([
    `linkedin ${primaryCompany} ${primaryLocation}`,
    `linkedin owner ${primaryCompany} ${primaryLocation}`,
    `linkedin founder ${primaryCompany} ${primaryLocation}`,
    `linkedin ceo ${primaryCompany} ${primaryLocation}`,
    `linkedin president ${primaryCompany} ${primaryLocation}`,
    `linkedin ${secondaryCompany} owner ${primaryLocation}`,
    `linkedin ${secondaryCompany} founder ${primaryLocation}`,
    `linkedin ${primaryCompany} ${secondaryLocation}`,
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

  const resultPattern = /^(?:\d+\.\s*)?(?:#+\s*)?\[(.*?)\]\((https?:\/\/[^)]+)\)$/;

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
      line.startsWith('About this page')
    ) {
      continue;
    }

    const match = line.match(resultPattern);
    if (match) {
      flush();
      current = {
        title: stripMarkdown(match[1] ?? ''),
        url: decodeUrl(match[2] ?? ''),
        snippet: '',
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (/^\d+\.\s*(?:#+\s*)?\[/.test(line)) {
      flush();
      const nextMatch = line.match(resultPattern);
      if (nextMatch) {
        current = {
          title: stripMarkdown(nextMatch[1] ?? ''),
          url: decodeUrl(nextMatch[2] ?? ''),
          snippet: '',
        };
      }
      continue;
    }

    if (/^\[.*\]\(.*\)$/.test(line)) {
      continue;
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
      current.snippet = `${current.snippet} ${line}`.trim();
      continue;
    }

    current.snippet = `${current.snippet} ${line}`.trim();
  }

  flush();
  return results;
};

const extractSearchResults = async (query: string) => {
  const settled = await Promise.allSettled(
    sourceUrls.map(async (source) => {
      const markdown = await fetchTextWithTimeout(source.buildUrl(query), searchTimeoutMs);
      const results = parseMarkdownResults(markdown, source.decodeUrl);
      return { source: source.name, results };
    }),
  );

  const merged: SearchResult[] = [];
  for (const item of settled) {
    if (item.status !== 'fulfilled') {
      continue;
    }

    for (const result of item.value.results) {
      if (!isLinkedInProfileUrl(result.url)) {
        continue;
      }

      merged.push(result);
    }
  }

  return merged;
};

const parseLinkedInTitle = (title: string) => {
  const cleaned = normalizeText(
    decodeHtmlEntities(title)
      .replace(/\s*[|]\s*LinkedIn.*$/i, '')
      .replace(/\s*-\s*LinkedIn.*$/i, '')
      .replace(/\s+LinkedIn.*$/i, ''),
  );

  const segments = cleaned
    .split(/\s+[–—-]\s+/)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);

  const name = segments[0] ?? cleaned;
  const headline = segments.slice(1).join(' - ');

  return {
    name,
    headline,
  };
};

const toLeadConfidence = (candidate: LinkedInCandidate) => {
  let score = 62;

  if (candidate.name) score += 10;
  if (candidate.headline) score += 8;
  if (candidate.snippet) score += 4;
  if (candidate.profileUrl.includes('/in/')) score += 8;
  if (candidate.snippet.toLowerCase().includes('linkedin')) score += 4;

  return Math.min(score, 92);
};

const buildLeadFromCandidate = (
  candidate: LinkedInCandidate,
  request: SearchRequest,
  location: NormalizedUsLocation,
): Lead => ({
  id: createId(candidate.profileUrl || `${candidate.name}-${candidate.headline ?? ''}`),
  name: normalizeText(candidate.name || candidate.headline || candidate.profileUrl),
  mobile: '',
  email: '',
  website: '',
  address: '',
  category: request.companyType,
  city: location.label,
  source: freeLinkedInSourceLabel,
  confidence: toLeadConfidence(candidate),
  sourceScore: 82,
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
  providerName: freeLinkedInSourceLabel,
  message: `No public LinkedIn profiles were returned for ${locationLabel}.`,
});

export const discoverUsLeadsFromLinkedinSearch = async ({
  request,
  location,
  deadlineMs,
}: {
  request: SearchRequest;
  location: NormalizedUsLocation;
  deadlineMs?: number;
}): Promise<Lead[]> => {
  const start = Date.now();
  const deadline = deadlineMs ?? start + 28_000;
  const queries = buildQueryVariants(request, location);
  const maxResults = Number(process.env.LINKEDIN_SEARCH_MAX_RESULTS ?? request.count);
  const candidates = new Map<string, LinkedInCandidate>();

  for (const query of queries) {
    if (Date.now() >= deadline || candidates.size >= maxResults) {
      break;
    }

    const queryResults = await extractSearchResults(query);
    for (const result of queryResults) {
      if (Date.now() >= deadline || candidates.size >= maxResults) {
        break;
      }

      const { name, headline } = parseLinkedInTitle(result.title);
      const profileUrl = result.url.trim();
      if (!profileUrl || candidates.has(profileUrl)) {
        continue;
      }

      candidates.set(profileUrl, {
        name,
        headline,
        profileUrl,
        snippet: result.snippet,
      });
    }
  }

  const leads = [...candidates.values()].map((candidate) =>
    buildLeadFromCandidate(candidate, request, location),
  );

  return leads;
};

export const buildLinkedinSearchWarning = buildNoResultsWarning;
