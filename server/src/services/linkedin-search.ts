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

type LinkedInRoleTerms = {
  primary: string[];
  category: string[];
};

export type LinkedInDiscoveryResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  blocked: boolean;
};

const maxQueries = 12;
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

const buildCompanyTerms = (request: SearchRequest, profile: ReturnType<typeof resolveCategoryProfile>) =>
  unique([
    ...profile.searchTerms,
    ...(profile.aliases ?? []),
    request.companyType,
    profile.label,
  ]).slice(0, 8);

const selectPrimaryCompanyTerm = (request: SearchRequest, companyTerms: string[]) => {
  const requestedTerm = normalizeQueryTerm(request.companyType);

  if (requestedTerm && (requestedTerm.includes(' ') || requestedTerm.length > 4)) {
    return requestedTerm;
  }

  return (
    companyTerms.find((term) => term.includes(' ') || term.length > 5) ??
    requestedTerm ??
    companyTerms[0] ??
    ''
  );
};

const selectSecondaryCompanyTerm = (companyTerms: string[], primaryCompany: string) =>
  companyTerms.find(
    (term) => term !== primaryCompany && (term.includes(' ') || term.length > 5),
  ) ??
  companyTerms.find((term) => term !== primaryCompany) ??
  primaryCompany;

const buildLocationTerms = (location: NormalizedUsLocation) =>
  unique([
    normalizeQueryTerm(location.label),
    normalizeQueryTerm(location.city || location.label),
    ...buildDiscoverySeeds(location).slice(0, 5).map(normalizeQueryTerm),
  ]).slice(0, 5);

const buildRoleTerms = (request: SearchRequest, profile: ReturnType<typeof resolveCategoryProfile>): LinkedInRoleTerms => {
  const normalizedContext = normalizeText(
    [request.companyType, profile.label, ...profile.searchTerms.slice(0, 6), ...(profile.aliases ?? []).slice(0, 6)].join(
      ' ',
    ),
  ).toLowerCase();

  const primaryRoles = [
    'founder',
    'owner',
    'business owner',
    'owner operator',
    'ceo',
    'co-founder',
    'president',
    'managing partner',
    'principal',
    'director',
  ];

  const categoryRoles: string[] = [];

  if (/(dentist|dental|orthodont|periodont|oral surgeon|clinic|urgent care|medical|veterin|health care|healthcare)/i.test(normalizedContext)) {
    categoryRoles.push('practice owner', 'clinic owner', 'office manager', 'practice manager', 'medical director', 'dental director');
  }

  if (/(hvac|plumb|electric|roof|clean|landscap|pest|move|auto repair|mechanic|car wash|service contractor|trade)/i.test(normalizedContext)) {
    categoryRoles.push('general manager', 'operations manager', 'service manager', 'field manager', 'franchise owner');
  }

  if (/(law|attorney|account|insurance|real estate|marketing|consult|software|saas|tech|agency)/i.test(normalizedContext)) {
    categoryRoles.push('partner', 'vice president', 'head of growth', 'head of operations');
  }

  if (/(restaurant|cafe|bakery|bar|hotel|grocery|clothing|electronics|furniture|salon|gym|school|college|day care|daycare)/i.test(normalizedContext)) {
    categoryRoles.push('operator', 'store manager', 'general manager', 'franchise owner');
  }

  if (/(ecommerce|e-commerce|d2c|direct to consumer|shopify|online store|brand)/i.test(normalizedContext)) {
    categoryRoles.push('brand founder', 'ecommerce manager', 'head of ecommerce', 'd2c founder', 'brand owner');
  }

  return {
    primary: unique(primaryRoles).slice(0, 10),
    category: unique(categoryRoles).slice(0, 12),
  };
};

const buildLinkedInQuery = (company: string, location: string, role?: string) =>
  normalizeText(
    [
      'site:linkedin.com/in/',
      role,
      company,
      location,
      '-jobs',
      '-company',
      '-school',
      '-posts',
      '-learning',
    ]
      .filter(Boolean)
      .join(' '),
  );

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
  const companyTerms = buildCompanyTerms(request, profile);
  const locationTerms = buildLocationTerms(location);
  const { primary: genericRoleTerms, category: categoryRoleTerms } = buildRoleTerms(request, profile);

  const primaryCompany = selectPrimaryCompanyTerm(request, companyTerms);
  const secondaryCompany = selectSecondaryCompanyTerm(companyTerms, primaryCompany);
  const primaryLocation = locationTerms[0] ?? normalizeQueryTerm(location.label);
  const secondaryLocation = locationTerms[1] ?? primaryLocation;

  const prioritizedRoleTerms = unique([...categoryRoleTerms, ...genericRoleTerms]);

  const companyQueries = unique([
    buildLinkedInQuery(primaryCompany, primaryLocation),
    buildLinkedInQuery(secondaryCompany, primaryLocation),
    buildLinkedInQuery(primaryCompany, secondaryLocation),
    ...companyTerms.slice(2, 5).map((company) => buildLinkedInQuery(company, primaryLocation)),
  ]);

  const locationQueries = locationTerms
    .slice(2, 5)
    .map((term) => buildLinkedInQuery(primaryCompany, term));

  const queryCandidates = unique([
    ...prioritizedRoleTerms.slice(0, 4).map((role) => buildLinkedInQuery(primaryCompany, primaryLocation, role)),
    ...companyQueries,
    ...prioritizedRoleTerms.slice(4, 8).map((role) => buildLinkedInQuery(primaryCompany, primaryLocation, role)),
    ...locationQueries,
  ]);

  const queryBudget = Math.min(maxQueries, Math.max(9, Math.ceil(request.count / 50) + 5));

  return queryCandidates.slice(0, queryBudget);
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
      .replace(/^(?:LinkedIn\s+)?(?:[a-z0-9-]+\.)?linkedin\.com\s*›\s*in\s*›\s*[^ ]+\s+/i, '')
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
