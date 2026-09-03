import { createHash } from 'node:crypto';

import { usStateNames, usStateProfiles, type UsStateCode } from '../data/us-states';
import type { EmploymentStatus, Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';
import type { NormalizedUsLocation } from './us-location';
import { timezoneStateQueries } from './us-timezones';
import { buildDiscoverySeeds } from './discovery-seeds';
import { buildDiscoveryQueryVariants } from './discovery-query-variants';
import { resolveCategoryProfile } from './us-category-mapping';
import { buildQueryTermVariants } from './query-term-variants';
import { isPublicHttpUrl } from '../utils/public-url';
import { getResearchDepthConfig } from './research-depth';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type CollectedSearchResult = SearchResult & {
  providerName: string;
};

type SearchSource = {
  name: string;
  label: string;
  kind: 'markdown' | 'bing-html' | 'duckduckgo-html' | 'yahoo-html';
  buildUrl: (query: string, page?: number) => string;
  decodeUrl: (value: string) => string;
};

type ProviderSearchResult = {
  results: SearchResult[];
  failure?: 'blocked' | 'fetch';
  message?: string;
};

type ProviderHealth = {
  attempts: number;
  failures: number;
  blockedResponses: number;
  disabled: boolean;
  lastMessage: string;
};

type LinkedInEvidenceSource = {
  providerName: string;
  title: string;
  snippet: string;
};

type LinkedInCandidate = {
  title: string;
  name: string;
  headline?: string;
  profileUrl: string;
  website?: string;
  snippet: string;
  publicEvidence: LinkedInEvidenceSource[];
  baseRelevanceScore: number;
  relevanceScore: number;
  matchedQueries: string[];
  matchedProviders: string[];
  matchedCategoryTerms: string[];
  matchedRoleTerms: string[];
  matchedLocationTerms: string[];
  matchedQueryFamilies: string[];
  location?: PublicProfileLocation;
};

type PublicProfileLocation = {
  city: string;
  stateCode: string;
  label: string;
};
type LinkedInRoleTerms = {
  primary: string[];
  category: string[];
};

export type LinkedInDiscoveryResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  blocked: boolean;
  coverage?: {
    queriesAttempted: number;
    providersChecked: number;
    providersPaused: number;
    acceptedCandidates: number;
    queryFamilies: string[];
    queryFamilyCounts: Record<string, number>;
  };
};

const readBoundedNumber = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => {
  const parsed = value?.trim() ? Number(value) : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
};

const maxQueries = readBoundedNumber(
  process.env.LINKEDIN_SEARCH_MAX_QUERIES,
  20,
  1,
  40,
);
const searchTimeoutMs = readBoundedNumber(
  process.env.LINKEDIN_SEARCH_TIMEOUT_MS,
  4_500,
  500,
  15_000,
);
// Keep the healthy phase fast while retaining a small cap on outbound public
// search traffic. Once a provider fails, runLinkedInQuerySet serializes work.
const queryBatchSize = 3;
const providerFailureThreshold = 2;
const queryCacheTtlMs = 15 * 60 * 1000;
const maxQueryCacheEntries = 300;
const publicSearchPageSize = 10;
const topQuerySourceCount = 4;
const rotatingQuerySourceCount = 2;
const sourceLabel = 'LinkedIn';
const leadSourceLabel = 'LinkedIn, Public Profile';
const providerId = 'linkedin-search';

// Collect bounded ranked headroom above the requested count. Public search
// engines often repeat the same employer or surface a weak profile first; the
// extra candidates let the final ranking prefer stronger, better corroborated
// public matches without ever returning more than the requested count.
const getCandidateBudget = (
  requestedCount: number,
  researchDepth?: SearchRequest['researchDepth'],
) => {
  const { queryMultiplier } = getResearchDepthConfig(researchDepth);

  return Math.min(
    600,
    requestedCount + Math.max(18, Math.ceil(requestedCount * 0.35 * queryMultiplier)),
  );
};

const queryCache = new Map<
  string,
  { expiresAt: number; result: ProviderSearchResult }
>();

const blockedBodyPatterns = [
  /(?:captcha|human verification) required/i,
  /too many requests/i,
  /unusual traffic/i,
  /verify.*not a bot/i,
  /we detected unusual traffic/i,
  /access denied/i,
  /temporarily blocked/i,
  /(?:cf-chl|just a moment|checking your browser|enable javascript)/i,
  /(?:robot check|prove you are human|rate limit(?:ed)?)/i,
  /temporarily unavailable/i,
  /anomaly\.js/i,
  /bots use duckduckgo/i,
];

const searchSources: SearchSource[] = [
  {
    name: 'brave',
    label: 'Brave Search',
    kind: 'markdown',
    buildUrl: (query: string, page = 0) =>
      `https://r.jina.ai/http://search.brave.com/search?q=${encodeURIComponent(query)}&source=web&offset=${page * publicSearchPageSize}`,
    decodeUrl: (value: string) => value,
  },
  {
    name: 'bing',
    label: 'Bing',
    kind: 'bing-html',
    buildUrl: (query: string, page = 0) =>
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=us&setlang=en-us&first=${page * publicSearchPageSize + 1}&count=${publicSearchPageSize}`,
    decodeUrl: (value: string) => decodeBingUrl(value),
  },
  {
    name: 'duckduckgo',
    label: 'DuckDuckGo',
    kind: 'duckduckgo-html',
    buildUrl: (query: string, page = 0) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${page * publicSearchPageSize}&dc=${page * publicSearchPageSize + 1}`,
    decodeUrl: (value: string) => decodeDuckDuckGoUrl(value),
  },
  {
    name: 'yahoo',
    label: 'Yahoo Search',
    kind: 'yahoo-html',
    buildUrl: (query: string, page = 0) =>
      `https://search.yahoo.com/search?p=${encodeURIComponent(query)}&b=${page * publicSearchPageSize + 1}&n=${publicSearchPageSize}`,
    decodeUrl: (value: string) => decodeYahooUrl(value),
  },
];

const normalizeText = (value?: string | null) =>
  (value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const decodeCodePoint = (value: string, radix: number) => {
  const codePoint = Number.parseInt(value, radix);

  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '';
};

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => decodeCodePoint(hex, 16))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => decodeCodePoint(decimal, 10));

const stripMarkdown = (value: string) =>
  decodeHtmlEntities(
    value
      .replace(/!\[[^\]]*\]\((?:[^)]+)\)/g, ' ')
      .replace(/\[([^\]]*?)\]\((https?:\/\/[^)]+)\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .trim(),
  );

const publicWebsiteTokenPattern =
  /(?:(?:https?:\/\/|www\.)[^\s<>"')\]]+|(?<![@\w])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>"')\]]*)?)/gi;

const extractUrls = (value: string) =>
  Array.from(value.matchAll(publicWebsiteTokenPattern), (match) => match[0]);

const excludedPublicWebsiteHosts = new Set([
  'bing.com',
  'brave.com',
  'duckduckgo.com',
  'facebook.com',
  'google.com',
  'healthgrades.com',
  'instagram.com',
  'linkedin.com',
  'opencare.com',
  'r.jina.ai',
  'twitter.com',
  'wikipedia.org',
  'x.com',
  'yelp.com',
  'yellowpages.com',
]);

const extractPublicWebsite = (...values: string[]) => {
  for (const value of values) {
    for (const rawUrl of extractUrls(value)) {
      try {
        const candidateUrl = /^(?:https?:\/\/)/i.test(rawUrl)
          ? rawUrl
          : `https://${rawUrl}`;
        const url = new URL(candidateUrl.replace(/[),.;:!?]+$/, ''));
        const hostname = url.hostname.toLowerCase().replace(/^www\./, '');

        if (
          !isPublicHttpUrl(url) ||
          [...excludedPublicWebsiteHosts].some(
            (host) => hostname === host || hostname.endsWith(`.${host}`),
          )
        ) {
          continue;
        }

        url.hash = '';
        return url.toString();
      } catch {
        // Search snippets can contain truncated or malformed URLs.
      }
    }
  }

  return undefined;
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

const decodeDuckDuckGoUrl = (value: string) => {
  try {
    const normalized = value.startsWith('//') ? `https:${value}` : value;
    const url = new URL(normalized, 'https://duckduckgo.com');
    const destination = url.searchParams.get('uddg');

    return destination ? decodeURIComponent(destination) : normalized;
  } catch {
    return value;
  }
};

const decodeYahooUrl = (value: string) => {
  const decode = (candidate: string) => {
    try {
      return decodeURIComponent(candidate.replace(/&amp;/g, '&'));
    } catch {
      return candidate;
    }
  };

  try {
    const normalized = value.startsWith('//') ? `https:${value}` : value;
    const url = new URL(normalized, 'https://search.yahoo.com');
    const destination =
      url.searchParams.get('RU') ??
      url.searchParams.get('u') ??
      url.searchParams.get('url');

    const pathDestination = normalized.match(/(?:^|\/)RU=([^/?#]+)/i)?.[1];

    return destination ? decode(destination) : pathDestination ? decode(pathDestination) : normalized;
  } catch {
    // Some Yahoo result pages use a path-based redirect instead of query
    // parameters. Keep the raw value so profile extraction can inspect it.
    return decode(value);
  }
};

const getCachedProviderResult = (key: string) => {
  if (process.env.NODE_ENV === 'test') {
    return undefined;
  }

  const cached = queryCache.get(key);
  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt <= Date.now()) {
    queryCache.delete(key);
    return undefined;
  }

  return cached.result;
};

const setCachedProviderResult = (key: string, result: ProviderSearchResult) => {
  // Empty responses can be caused by provider drift or geo/rate-limit pages
  // that still return HTTP 200. Do not turn one transient miss into a 15-minute
  // false zero-result search.
  if (process.env.NODE_ENV === 'test' || result.failure || !result.results.length) {
    return;
  }

  if (queryCache.size >= maxQueryCacheEntries) {
    const oldestKey = queryCache.keys().next().value as string | undefined;
    if (oldestKey) {
      queryCache.delete(oldestKey);
    }
  }

  queryCache.set(key, {
    expiresAt: Date.now() + queryCacheTtlMs,
    result,
  });
};

const createId = (value: string) =>
  `linkedin-${createHash('sha1').update(value).digest('hex')}`;

const unique = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values.map(normalizeText).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
};

const normalizeQueryTerm = (value: string) =>
  normalizeText(value)
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s*["'’`]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildCompanyTerms = (request: SearchRequest, profile: ReturnType<typeof resolveCategoryProfile>) =>
  unique([
    ...buildQueryTermVariants(request.companyType),
    ...profile.searchTerms,
    ...(profile.aliases ?? []),
    request.companyType,
    profile.label,
  ]).slice(0, 8);

const buildAliasCompanyTerms = (
  request: SearchRequest,
  profile: ReturnType<typeof resolveCategoryProfile>,
) => {
  const canonicalKeys = new Set(
    unique([
      ...buildQueryTermVariants(request.companyType),
      request.companyType,
      profile.label,
      ...profile.searchTerms,
    ]).map((term) =>
      normalizeQueryTerm(term).toLowerCase(),
    ),
  );

  return unique(profile.aliases ?? [])
    .filter((alias) => !canonicalKeys.has(normalizeQueryTerm(alias).toLowerCase()))
    .slice(0, 4);
};

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

const buildLocationTerms = (location: NormalizedUsLocation) => {
  const discoverySeeds = buildDiscoverySeeds(location).map(normalizeQueryTerm);

  if (location.mode === 'timezone' || location.mode === 'nationwide') {
    // Search engines understand concrete metros much better than labels such as
    // "Eastern Time", so broad searches rotate through representative cities.
    return unique(discoverySeeds).slice(0, 10);
  }

  return unique([
    normalizeQueryTerm(location.label),
    normalizeQueryTerm(location.city || location.label),
    ...discoverySeeds.slice(0, 8),
  ]).slice(0, 8);
};

const buildRoleTerms = (request: SearchRequest, profile: ReturnType<typeof resolveCategoryProfile>): LinkedInRoleTerms => {
  const normalizedContext = normalizeText(
    [request.companyType, profile.label, ...profile.searchTerms.slice(0, 6), ...(profile.aliases ?? []).slice(0, 6)].join(
      ' ',
    ),
  ).toLowerCase();

  const primaryRoles = [
    'founder',
    'owner',
    'co-owner',
    'business owner',
    'owner operator',
    'ceo',
    'chief operating officer',
    'coo',
    'general manager',
    'operations manager',
    'field manager',
    'branch manager',
    'service manager',
    'installation manager',
    'dispatch manager',
    'project manager',
    'estimator',
    'sales manager',
    'account manager',
    'co-founder',
    'president',
    'managing partner',
    'managing member',
    'proprietor',
    'franchisee',
    'managing director',
    'executive director',
    'principal',
    'director',
    'director of operations',
    'director of sales',
    'operations director',
    'sales director',
    'vice president',
    'vp',
    'chief technology officer',
    'cto',
    'chief marketing officer',
    'cmo',
    'chief sales officer',
    'cro',
    'head of sales',
    'head of growth',
    'head of operations',
    'regional manager',
    'business development manager',
    'business development director',
  ];

  const categoryRoles: string[] = [];

  if (/(hospital|pharmacy|medical center|surgery center|health system|nursing)/i.test(normalizedContext)) {
    categoryRoles.push(
      'hospital administrator',
      'pharmacy manager',
      'practice administrator',
      'clinical director',
      'director of nursing',
      'healthcare administrator',
    );
  }

  if (/(dentist|dental|orthodont|periodont|oral surgeon|clinic|urgent care|medical|veterin|health care|healthcare)/i.test(normalizedContext)) {
    categoryRoles.push(
      'practice owner',
      'clinic owner',
      'office manager',
      'practice manager',
      'medical director',
      'office administrator',
      'administrator',
      'clinical director',
      'dental director',
      'provider',
    );
  }

  if (/(hvac|plumb|electric|roof|clean|landscap|pest|move|auto repair|mechanic|car wash|service contractor|trade)/i.test(normalizedContext)) {
    categoryRoles.push(
      'general manager',
      'operations manager',
      'service manager',
      'service director',
      'field manager',
      'branch manager',
      'installation manager',
      'dispatch manager',
      'project manager',
      'estimator',
      'sales manager',
      'franchise owner',
    );
  }

  if (/(school|college|university|academy|education)/i.test(normalizedContext)) {
    categoryRoles.push(
      'school principal',
      'superintendent',
      'dean',
      'admissions director',
      'school administrator',
      'education director',
    );
  }

  if (/(restaurant|cafe|bakery|bar|hotel|grocery|clothing|electronics|furniture|salon|gym|school|college|day care|daycare)/i.test(normalizedContext)) {
    categoryRoles.push(
      'operator',
      'store owner',
      'store manager',
      'location manager',
      'district manager',
      'general manager',
      'franchise owner',
      'franchisee',
    );
  }

  if (/(car dealership|dealership|automotive|auto dealer)/i.test(normalizedContext)) {
    categoryRoles.push(
      'dealer principal',
      'fixed operations director',
      'internet sales manager',
      'automotive general manager',
      'service director',
      'sales director',
    );
  }

  if (/(church|mosque|temple|synagogue|place of worship|religious)/i.test(normalizedContext)) {
    categoryRoles.push(
      'pastor',
      'minister',
      'rabbi',
      'imam',
      'executive pastor',
      'church administrator',
      'worship director',
    );
  }

  if (/(ecommerce|e-commerce|d2c|direct to consumer|shopify|online store|brand)/i.test(normalizedContext)) {
    categoryRoles.push(
      'brand founder',
      'ecommerce manager',
      'head of ecommerce',
      'd2c founder',
      'brand owner',
      'merchandising manager',
    );
  }

  if (/(accounting|bookkeeping|tax|cpa|audit)/i.test(normalizedContext)) {
    categoryRoles.push(
      'tax partner',
      'accounting manager',
      'controller',
      'firm administrator',
      'managing accountant',
    );
  }

  if (/(insurance|financial|wealth|bank|credit union|mortgage|brokerage)/i.test(normalizedContext)) {
    categoryRoles.push(
      'financial advisor',
      'agency principal',
      'insurance agency owner',
      'wealth manager',
      'mortgage broker',
      'branch manager',
    );
  }

  if (/(staffing|recruit|human resources|\bhr\b)/i.test(normalizedContext)) {
    categoryRoles.push(
      'staffing manager',
      'recruiting manager',
      'talent acquisition manager',
      'recruiting director',
      'branch manager',
    );
  }

  if (/(logistics|trucking|freight|warehouse|fulfillment|courier|delivery)/i.test(normalizedContext)) {
    categoryRoles.push(
      'logistics manager',
      'warehouse manager',
      'supply chain manager',
      'fleet manager',
      'distribution manager',
    );
  }

  if (/(manufactur|factory|industrial|production|distribution)/i.test(normalizedContext)) {
    categoryRoles.push(
      'plant manager',
      'production manager',
      'supply chain manager',
      'quality manager',
      'manufacturing director',
    );
  }

  if (/(hotel|hospitality|resort|event|catering)/i.test(normalizedContext)) {
    categoryRoles.push(
      'hotel general manager',
      'revenue manager',
      'event director',
      'food and beverage manager',
      'hospitality manager',
    );
  }

  if (/(fitness|gym|wellness|yoga|pilates|personal training|studio)/i.test(normalizedContext)) {
    categoryRoles.push(
      'studio owner',
      'fitness director',
      'gym manager',
      'wellness director',
      'membership director',
    );
  }

  if (/(salon|spa|barber|beauty|esthetic)/i.test(normalizedContext)) {
    categoryRoles.push(
      'salon owner',
      'spa director',
      'salon manager',
      'beauty director',
      'studio owner',
    );
  }

  if (/(property management|apartment|multifamily|leasing|commercial property)/i.test(normalizedContext)) {
    categoryRoles.push(
      'property manager',
      'community manager',
      'leasing manager',
      'asset manager',
      'property director',
    );
  }

  if (/(nonprofit|non-profit|foundation|charity|community organization)/i.test(normalizedContext)) {
    categoryRoles.push(
      'development director',
      'program director',
      'fundraising director',
      'volunteer coordinator',
      'community director',
    );
  }

  if (/(solar|renewable|clean energy|battery|wind energy)/i.test(normalizedContext)) {
    categoryRoles.push(
      'solar sales manager',
      'energy consultant',
      'renewable energy manager',
      'project manager',
      'installation manager',
    );
  }

  if (/(construction|builder|general contractor|remodel|renovation)/i.test(normalizedContext)) {
    categoryRoles.push(
      'construction manager',
      'superintendent',
      'project executive',
      'estimator',
      'preconstruction manager',
    );
  }

  if (/(security|alarm|surveillance|guard service)/i.test(normalizedContext)) {
    categoryRoles.push(
      'security operations manager',
      'security director',
      'branch manager',
      'account manager',
      'loss prevention manager',
    );
  }

  if (/(home care|elder care|senior care|assisted living|nursing home)/i.test(normalizedContext)) {
    categoryRoles.push(
      'executive director',
      'care administrator',
      'director of nursing',
      'care manager',
      'resident care director',
    );
  }

  if (/(child care|childcare|daycare|preschool|early learning)/i.test(normalizedContext)) {
    categoryRoles.push(
      'center director',
      'childcare director',
      'school director',
      'program director',
      'preschool director',
    );
  }

  if (/(technology|software|cybersecurity|information technology|cloud services|saas)/i.test(normalizedContext)) {
    categoryRoles.push(
      'it director',
      'engineering manager',
      'vp of engineering',
      'product manager',
      'customer success director',
    );
  }

  if (/(law|attorney|account|insurance|real estate|marketing|consult|software|saas|tech|agency)/i.test(normalizedContext)) {
    categoryRoles.push(
      'partner',
      'managing attorney',
      'founding partner',
      'managing member',
      'vice president',
      'head of growth',
      'head of operations',
      'business development',
      'account manager',
    );
  }

  return {
    primary: unique(primaryRoles).slice(0, 24),
    category: unique(categoryRoles).slice(0, 12),
  };
};

const quoteQueryTerm = (value: string) => {
  const normalized = normalizeQueryTerm(value);
  return normalized.includes(' ') ? `"${normalized}"` : normalized;
};

const publicSearchNoiseFilters = [
  { term: 'jobs', filter: '-jobs' },
  { term: 'careers', filter: '-careers' },
  { term: 'intern', filter: '-intern' },
  { term: 'student', filter: '-student' },
];

const addPublicSearchNoiseFilters = (query: string) => {
  const normalizedQuery = query.toLowerCase();
  const filters = publicSearchNoiseFilters
    .filter(({ term }) => !new RegExp(`\\b${term}\\b`, 'i').test(normalizedQuery))
    .map(({ filter }) => filter);

  return normalizeText([query, ...filters].filter(Boolean).join(' '));
};

const buildBooleanQuery = (terms: string[], limit: number) => {
  const quotedTerms = unique(terms)
    .slice(0, limit)
    .map(quoteQueryTerm)
    .filter(Boolean);

  if (quotedTerms.length <= 1) {
    return quotedTerms[0] ?? '';
  }

  return `(${quotedTerms.join(' OR ')})`;
};

const ownerRolePattern =
  /\b(founder|co-founder|owner|co-owner|business owner|owner operator|proprietor|franchisee|franchise owner|president|principal|managing partner|managing member|brand owner|brand founder|practice owner|clinic owner|store owner|agency principal|insurance agency owner|dealer principal)\b/i;

const isOwnerRoleTerm = (term: string) => ownerRolePattern.test(normalizeText(term));

const getLinkedInQueryFamily = (query: string) => {
  const normalized = query.toLowerCase();

  if (normalized.includes('site:linkedin.com/pub/')) {
    return 'legacy-profile';
  }

  if (normalized.includes(' or ')) {
    return 'multi-term-cluster';
  }

  if (ownerRolePattern.test(normalized)) {
    return 'owner-led';
  }

  if (
    /\b(founder|owner|ceo|president|director|manager|operator|partner|principal|administrator|head of|vice president|vp)\b/i.test(
      normalized,
    )
  ) {
    return 'role-led';
  }

  return 'category-location';
};

type LinkedInProfilePath = 'in' | 'pub';

const publicLinkedInProfilePaths: LinkedInProfilePath[] = ['in', 'pub'];

const buildLinkedInQuery = (
  company: string,
  location: string,
  role?: string,
  profilePath: LinkedInProfilePath = 'in',
) =>
  addPublicSearchNoiseFilters(
    normalizeText(
      [
        `site:linkedin.com/${profilePath}/`,
        role ? quoteQueryTerm(role) : '',
        quoteQueryTerm(company),
        quoteQueryTerm(location),
      ]
        .filter(Boolean)
        .join(' '),
    ),
  );

const buildLinkedInQueryFromPhrase = (
  phrase: string,
  profilePath: LinkedInProfilePath = 'in',
) =>
  addPublicSearchNoiseFilters(
    normalizeText(
      [`site:linkedin.com/${profilePath}/`, phrase].filter(Boolean).join(' '),
    ),
  );

const buildLinkedInProfilePathQueries = (phrase: string) =>
  publicLinkedInProfilePaths.map((profilePath) =>
    buildLinkedInQueryFromPhrase(phrase, profilePath),
  );

const prioritizeRoleTerms = (genericRoleTerms: string[], categoryRoleTerms: string[]) => {
  const genericCoverageOrder = [
    'founder',
    'chief operating officer',
    'coo',
    'general manager',
    'field manager',
    'operations manager',
    'owner',
    'ceo',
    'branch manager',
    'service manager',
    'installation manager',
    'dispatch manager',
    'project manager',
    'estimator',
    'sales manager',
    'account manager',
  ];
  const genericCoverage = unique([
    ...genericCoverageOrder.map((role) =>
      genericRoleTerms.find((term) => term.toLowerCase() === role) ?? '',
    ),
    ...genericRoleTerms,
  ]);

  // Keep one sector-specific role and the highest-signal general roles in the
  // first query window, then rotate through the remaining sector roles.
  return unique([
    categoryRoleTerms[0] ?? '',
    ...genericCoverage.slice(0, 6),
    ...categoryRoleTerms.slice(1, 6),
    ...genericCoverage.slice(6),
    ...categoryRoleTerms.slice(6),
  ]);
};

const normalizeLinkedInProfileUrl = (value?: string) => {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 'linkedin.com' && !hostname.endsWith('.linkedin.com')) {
      return null;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const profilePath = segments[0]?.toLowerCase();
    if ((profilePath !== 'in' && profilePath !== 'pub') || !segments[1]) {
     return null;
   }

    const slug = segments[1].trim().toLowerCase().replace(/[.,;:!?]+$/, '');
    if (!slug) {
      return null;
    }

    return `https://linkedin.com/${profilePath}/${slug}`;
  } catch {
    return null;
  }
};

const extractLinkedInProfileReference = (value: string) => {
  const directMatch = value.match(
    /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[^\s<>")\]]+/i,
  );
  const directProfile = normalizeLinkedInProfileUrl(directMatch?.[0]);
  if (directProfile) {
    return directProfile;
  }

  const navigationMatch = value.match(
    /linkedin\.com\s*[›>]\s*(in|pub)\s*[›>]\s*([a-z0-9][a-z0-9-]{1,120})/i,
  );

  return normalizeLinkedInProfileUrl(
    navigationMatch?.[1] && navigationMatch[2]
      ? `https://linkedin.com/${navigationMatch[1]}/${navigationMatch[2]}`
      : undefined,
  );
};

const extractLinkedInProfileReferences = (
  value: string,
  decodedUrls: string[] = [],
) => {
  const profiles = new Set<string>();
  const addProfile = (candidate?: string) => {
    const profile = normalizeLinkedInProfileUrl(candidate);
    if (profile) {
      profiles.add(profile);
    }
  };

  decodedUrls.forEach(addProfile);
  for (const match of value.matchAll(
    /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[^\s<>\")\]]+/gi,
  )) {
    addProfile(match[0]);
  }

  for (const match of value.matchAll(
    /linkedin\.com\s*[›>]\s*(in|pub)\s*[›>]\s*([a-z0-9][a-z0-9-]{1,120})/gi,
  )) {
    addProfile(`https://linkedin.com/${match[1]}/${match[2]}`);
  }

  return [...profiles];
};

const isLinkedInProfileUrl = (value: string) => Boolean(normalizeLinkedInProfileUrl(value));

const slugToName = (value?: string) => {
  const normalized = normalizeLinkedInProfileUrl(value);
  if (!normalized) {
    return '';
  }

  const slug = normalized.match(/\/(?:in|pub)\/([^/?#]+)/i)?.[1] ?? '';

  return slug
    .split('-')
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        !/^\d+$/.test(part) &&
        !/^(?=[a-z0-9]*\d)[a-z0-9]{6,}$/i.test(part) &&
        part.toLowerCase() !== 'profile',
    )
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .trim();
};

const hasLinkedInProfileSignals = (value: string) =>
  /linkedin|professional profile|profile on linkedin|connections:|followers:|works for:|experience:/i.test(
    value,
  );

const decisionMakerPattern =
  /\b(founder|co-founder|co-owner|owner|owner operator|business owner|proprietor|franchisee|franchise owner|chief executive|ceo|chief operating officer|coo|chief technology officer|cto|chief marketing officer|cmo|chief sales officer|cro|president|principal|partner|managing partner|managing member|managing director|executive director|director|head of|vice president|vp|regional manager|branch manager|business development|business development manager|business development director|general manager|operations manager|operations director|office manager|practice manager|medical director|clinical director|dental director|administrator|service manager|service director|field manager|installation manager|dispatch manager|project manager|estimator|sales manager|account manager|store owner|store manager|location manager|district manager|operator|brand owner|brand founder|ecommerce manager|head of ecommerce|merchandising manager|hospital administrator|pharmacy manager|practice administrator|healthcare administrator|director of nursing|school principal|superintendent|dean|admissions director|school administrator|education director|dealer principal|fixed operations director|internet sales manager|automotive general manager|pastor|minister|rabbi|imam|executive pastor|church administrator|worship director|tax partner|accounting manager|controller|firm administrator|managing accountant|financial advisor|agency principal|insurance agency owner|wealth manager|mortgage broker|staffing manager|recruiting manager|talent acquisition manager|recruiting director|logistics manager|warehouse manager|supply chain manager|fleet manager|distribution manager|plant manager|production manager|quality manager|manufacturing director|hotel general manager|revenue manager|event director|food and beverage manager|hospitality manager|studio owner|fitness director|gym manager|wellness director|membership director|salon owner|spa director|salon manager|beauty director|property manager|community manager|leasing manager|asset manager|property director|development director|program director|fundraising director|volunteer coordinator|community director|solar sales manager|energy consultant|renewable energy manager|construction manager|superintendent|project executive|preconstruction manager|security operations manager|security director|loss prevention manager|care administrator|care manager|resident care director|center director|childcare director|school director|preschool director|it director|engineering manager|vp of engineering|product manager|customer success director)\b/i;
const businessNamePattern =
  /\b(clinic|dentist|dentists|dentistry|dental|orthodontics?|company|services|solutions|agency|group|associates|partners|llc|inc\.?|corp\.?|corporation|store|shop|school|university|hospital|restaurant|salon|spa|plumbing|roofing|heating|cooling|hvac)\b/i;
const companyIdentityPattern =
  /\b(clinic|dentistry|dental|company|services|solutions|agency|group|associates|partners|llc|inc\.?|corp\.?|corporation|store|shop|school|university|hospital|restaurant|salon|spa|plumbing|roofing|heating|cooling|hvac)\b/i;
const nonLeadContextPattern =
  /\b(student|researcher|professor|faculty|lecturer|intern|graduate|undergraduate|postdoctoral|phd candidate|academic)\b/i;
const academicInstitutionPattern =
  /\b(university|college|school of|medical school|dental school|graduate school|law school)\b/i;
const credentialPattern =
  /\b(dr\.?|dds|dmd|md|do|phd|cpa|esq\.?|jd|mba|rn|dvm)\b/gi;
const credentialIdentityPattern =
  /\b(dr\.?|dds|dmd|md|do|phd|cpa|esq\.?|jd|mba|rn|dvm)\b/i;
const professionalTitlePattern =
  /\b(dentist|orthodontist|periodontist|oral surgeon|doctor|physician|veterinarian|plumber|electrician|roofer|hvac|mechanic|attorney|lawyer|accountant|realtor|real estate agent|broker|consultant|architect|engineer|designer|developer|therapist|nurse|pharmacist|chiropractor|esthetician|barber|stylist|chef|advisor|analyst|strategist|specialist|technician)\b/i;
const categoryStopWords = new Set([
  'business',
  'company',
  'companies',
  'contractor',
  'contractors',
  'service',
  'services',
  'agency',
  'agencies',
  'clinic',
  'clinics',
  'office',
  'local',
]);

const normalizeMatchText = (value: string) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const publicStateCodeByValue = new Map(
  usStateProfiles.flatMap((state) => [
    [state.code.toLowerCase(), state.code],
    [state.name.toLowerCase(), state.code],
  ]),
);
const publicStatePattern = usStateProfiles
  .flatMap((state) => [state.code, state.name])
  .sort((left, right) => right.length - left.length)
  .join('|');
const publicStateNamePattern = usStateProfiles
  .map((state) => state.name)
  .sort((left, right) => right.length - left.length)
  .join('|');
const publicLocationPattern = new RegExp(
  "\\b(?:based\\s+in|located\\s+in|serving|in|from)\\s+([A-Za-z][A-Za-z.'-]*(?:\\s+[A-Za-z][A-Za-z.'-]*){0,3}),\\s*(" + publicStatePattern + ")\\b",
  'i',
);
const publicUnpunctuatedLocationNamePattern = new RegExp(
  "\\b(?:based\\s+in|located\\s+in|serving|in|from)\\s+([A-Za-z][A-Za-z.'-]*(?:\\s+[A-Za-z][A-Za-z.'-]*){0,3})\\s+(" + publicStateNamePattern + ")\\b",
  'i',
);
const publicUnpunctuatedLocationCodePattern =
  /\b(?:based\s+in|located\s+in|serving|in|from)\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})\s+([A-Z]{2})\b/i;
const publicCityStatePattern = new RegExp(
  "\\b([A-Za-z][A-Za-z.'-]*(?:\\s+[A-Za-z][A-Za-z.'-]*){0,3}),\\s*(" + publicStatePattern + ")\\b",
  'i',
);

const normalizePublicCity = (value: string) =>
  normalizeText(value)
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

const publicLocationNoiseWords = new Set([
  'dds',
  'dmd',
  'dvm',
  'esq',
  'jd',
  'mba',
  'md',
  'do',
  'phd',
  'cpa',
  'rn',
  'america',
  'states',
  'united',
]);

const publicLocationPrefixNoiseWords = new Set([
  'and',
  'at',
  'based',
  'for',
  'from',
  'in',
  'located',
  'of',
  'serving',
  'the',
]);

const foreignLocationPattern =
  /\b(?:india|canada|mexico|brazil|australia|new zealand|singapore|pakistan|bangladesh|philippines|germany|france|spain|italy|china|japan|south africa|united kingdom|uae|united arab emirates)\b/i;
const foreignCityPattern =
  /\b(?:noida|gurgaon|gurugram|new delhi|bengaluru|bangalore|hyderabad|chennai|pune|kolkata|mumbai|karachi|lahore|dhaka|manila|toronto|vancouver|montreal|calgary|sydney|melbourne|auckland|dubai|abu dhabi)\b/i;

const extractExplicitProfileStateCode = (
  candidate: Pick<LinkedInCandidate, 'title' | 'headline' | 'snippet'>,
) => {
  const searchableValues = [
    normalizeText(`${candidate.title} ${candidate.headline ?? ''}`),
    normalizeText(candidate.snippet),
  ];

  for (const value of searchableValues) {
    const match =
      publicLocationPattern.exec(value) ??
      publicUnpunctuatedLocationNamePattern.exec(value) ??
      publicUnpunctuatedLocationCodePattern.exec(value);
    const stateCode = publicStateCodeByValue.get((match?.[2] ?? '').toLowerCase());

    if (stateCode) {
      return stateCode;
    }
  }

  return undefined;
};

const extractPublicProfileLocation = (
  candidate: Pick<LinkedInCandidate, 'title' | 'headline' | 'snippet'>,
  requestedLocation: NormalizedUsLocation,
) => {
  const identityText = normalizeText(`${candidate.title} ${candidate.headline ?? ''}`);
  const snippetText = normalizeText(candidate.snippet);
  const identityMatch =
    publicLocationPattern.exec(identityText) ??
    publicUnpunctuatedLocationNamePattern.exec(identityText) ??
    publicUnpunctuatedLocationCodePattern.exec(identityText) ??
    publicCityStatePattern.exec(identityText);
  const contextualSnippetMatch =
    publicLocationPattern.exec(snippetText) ??
    publicUnpunctuatedLocationNamePattern.exec(snippetText) ??
    publicUnpunctuatedLocationCodePattern.exec(snippetText);
  const match = identityMatch ?? contextualSnippetMatch;
  const rawCity = normalizeText(match?.[1] ?? '');
  const stateCode = publicStateCodeByValue.get((match?.[2] ?? '').toLowerCase()) ?? '';
  const cityWords = rawCity.split(/\s+/).filter(Boolean);
  const discoveryCityHints = new Set(
    buildDiscoverySeeds(requestedLocation)
      .filter((seed) => seed.includes(','))
      .map((seed) => normalizeMatchText(seed.split(',')[0] ?? ''))
      .filter((seed) => seed.length >= 2),
  );
  if (requestedLocation.city) {
    discoveryCityHints.add(normalizeMatchText(requestedLocation.city));
  }
  const cityCandidates = cityWords.flatMap((_, startIndex) => {
    const value = cityWords.slice(startIndex).join(' ');
    const normalized = normalizeMatchText(value);

    if (
      !normalized ||
      publicLocationNoiseWords.has(normalized) ||
      publicLocationPrefixNoiseWords.has(normalized)
    ) {
      return [];
    }

    return [{ value, normalized }];
  });
  const hintedCity = cityCandidates.find((candidateCity) =>
    [...discoveryCityHints].some(
      (hint) =>
        candidateCity.normalized === hint ||
        candidateCity.normalized.startsWith(`${hint} `) ||
        hint.startsWith(`${candidateCity.normalized} `),
    ),
  );
  // Search snippets frequently contain phrases such as "Private Practice
  // Specializing, IN" that resemble a city/state pair. Only expose a public
  // location when the city also matches a known query seed or the requested
  // city; otherwise the profile remains usable without fabricated geography.
  const selectedCity = hintedCity?.value;
  const city = normalizePublicCity(selectedCity ?? '');

  if (
    !city ||
    city.length < 2 ||
    publicLocationNoiseWords.has(normalizeMatchText(city)) ||
    !stateCode
  ) {
    return undefined;
  }

  return {
    city,
    stateCode,
    label: `${city}, ${stateCode}`,
  } satisfies PublicProfileLocation;
};
const geographicQualifierPattern =
  /^(?:greater\s+)?(?:north(?:west|east)?|south(?:west|east)?|east|west|central|downtown|metro(?:politan)?)\s+/i;

const isLocationOrganizationName = (value: string, location: NormalizedUsLocation) => {
  const normalizedName = normalizeMatchText(value);
  const normalizedCity = normalizeMatchText(location.city);

  if (!normalizedCity) {
    return false;
  }

  return (
    normalizedName === normalizedCity ||
    normalizedName.replace(geographicQualifierPattern, '') === normalizedCity
  );
};

const isLikelyPersonName = (value: string) => {
  const normalized = normalizeText(value);
  const withoutCredentials = normalizeText(normalized.replace(credentialPattern, ' '));
  const words = withoutCredentials
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}'-]/gu, ''))
    .filter((word) => /\p{L}/u.test(word));

  if (words.length < 2 || words.length > 7) {
    return false;
  }

  if (decisionMakerPattern.test(withoutCredentials) || businessNamePattern.test(withoutCredentials)) {
    return false;
  }

  return words.every((word) => word.length >= 2);
};

const buildCategoryEvidenceTerms = (
  request: SearchRequest,
  profile: ReturnType<typeof resolveCategoryProfile>,
) => {
  const phrases = unique([
    request.companyType,
    ...buildQueryTermVariants(request.companyType),
    profile.label,
    ...buildQueryTermVariants(profile.label),
    ...profile.searchTerms.flatMap(buildQueryTermVariants),
    ...(profile.aliases ?? []).flatMap(buildQueryTermVariants),
  ]).map(normalizeMatchText);
  const significantWords = phrases.flatMap((phrase) =>
    phrase
      .split(' ')
      .filter((word) => word.length >= 5 && !categoryStopWords.has(word)),
  );

  return unique([...phrases, ...significantWords]);
};

const buildLocationEvidenceTerms = (location: NormalizedUsLocation) => {
  const queryTerms = buildLocationTerms(location);

  if (location.mode === 'timezone' && location.timeZoneCode) {
    return unique([
      ...queryTerms,
      ...(timezoneStateQueries[location.timeZoneCode] ?? []),
    ]).map(normalizeMatchText);
  }

  if (location.mode === 'nationwide') {
    return unique([
      ...queryTerms,
      ...usStateProfiles.flatMap((state) => [state.name, state.code]),
    ]).map(normalizeMatchText);
  }

  return queryTerms.map(normalizeMatchText);
};

const matchesEvidence = (searchable: string, terms: string[]) =>
  terms.some((term) => {
    const normalizedTerm = normalizeMatchText(term);
    if (!normalizedTerm) {
      return false;
    }

    const escapedTerm = normalizedTerm
      .replace(/[.*+?^${}()|[\[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');

    return new RegExp(`(?:^|\\s)${escapedTerm}(?=$|\\s)`).test(searchable);
  });

const matchingEvidenceTerms = (searchable: string, terms: string[]) =>
  unique(terms.filter((term) => matchesEvidence(searchable, [term]))).slice(0, 8);

type CandidateMatchEvidence = {
  categoryMatchedTerms: string[];
  categoryIdentityMatchedTerms: string[];
  categoryRoleMatchedTerms: string[];
  roleMatchedTerms: string[];
  locationMatchedTerms: string[];
  hasCategoryEvidence: boolean;
  hasCategoryIdentityEvidence: boolean;
  hasRoleEvidence: boolean;
  ownerMatched: boolean;
  hasCredentialEvidence: boolean;
  hasProfessionalTitleEvidence: boolean;
  hasLocationEvidence: boolean;
  hasProfileEvidence: boolean;
};

const getCandidateMatchEvidence = (
  candidate: Pick<
    LinkedInCandidate,
    'title' | 'headline' | 'profileUrl' | 'website' | 'snippet' | 'location' | 'name'
  >,
  request: SearchRequest,
  location: NormalizedUsLocation,
): CandidateMatchEvidence => {
  const profile = resolveCategoryProfile(request.companyType);
  const categoryTerms = buildCategoryEvidenceTerms(request, profile);
  const locationTerms = buildLocationEvidenceTerms(location);
  const { primary: genericRoleTerms, category: categoryRoleTerms } = buildRoleTerms(
    request,
    profile,
  );
  const roleTerms = unique([...genericRoleTerms, ...categoryRoleTerms]);
  const identitySearchable = normalizeMatchText(
    `${candidate.title} ${candidate.headline ?? ''}`,
  );
  const searchable = normalizeMatchText(
    `${candidate.title} ${candidate.headline ?? ''} ${candidate.snippet}`,
  );
  const categoryMatchedTerms = matchingEvidenceTerms(searchable, categoryTerms);
  const categoryIdentityMatchedTerms = matchingEvidenceTerms(
    identitySearchable,
    categoryTerms,
  );
  const categoryRoleMatchedTerms = matchingEvidenceTerms(
    identitySearchable,
    categoryRoleTerms,
  );
  const roleMatchedTerms = matchingEvidenceTerms(identitySearchable, roleTerms);
  const fallbackRoleTerm = identitySearchable.match(decisionMakerPattern)?.[0] ?? '';

  if (fallbackRoleTerm && !roleMatchedTerms.some((term) => term.toLowerCase() === fallbackRoleTerm.toLowerCase())) {
    roleMatchedTerms.push(fallbackRoleTerm);
  }

  const locationMatchedTerms = matchingEvidenceTerms(searchable, locationTerms);

  return {
    categoryMatchedTerms,
    categoryIdentityMatchedTerms,
    categoryRoleMatchedTerms,
    roleMatchedTerms,
    locationMatchedTerms,
    hasCategoryEvidence: categoryMatchedTerms.length > 0,
    hasCategoryIdentityEvidence: categoryIdentityMatchedTerms.length > 0,
    hasRoleEvidence: roleMatchedTerms.length > 0 || decisionMakerPattern.test(identitySearchable),
    ownerMatched: roleMatchedTerms.some(isOwnerRoleTerm),
    hasCredentialEvidence: credentialIdentityPattern.test(identitySearchable),
    hasProfessionalTitleEvidence: professionalTitlePattern.test(identitySearchable),
    hasLocationEvidence: locationMatchedTerms.length > 0,
    hasProfileEvidence:
      hasLinkedInProfileSignals(candidate.title) || hasLinkedInProfileSignals(candidate.snippet),
  };
};

const scoreCandidateRelevance = (
  candidate: Pick<
    LinkedInCandidate,
    'title' | 'name' | 'headline' | 'profileUrl' | 'website' | 'snippet' | 'location'
  >,
  request: SearchRequest,
  location: NormalizedUsLocation,
  evidence: CandidateMatchEvidence,
) => {
  if (
    !isLikelyPersonName(candidate.name) ||
    isLocationOrganizationName(candidate.name, location)
  ) {
    return 0;
  }

  const profile = resolveCategoryProfile(request.companyType);
  const identitySearchable = normalizeMatchText(
    `${candidate.title} ${candidate.headline ?? ''}`,
  );
  const searchable = normalizeMatchText(
    `${candidate.title} ${candidate.headline ?? ''} ${candidate.snippet}`,
  );

  if (
    candidate.location &&
    location.mode === 'timezone' &&
    location.timeZoneCode
  ) {
    const stateName = usStateNames[candidate.location.stateCode as UsStateCode];
    const allowedStates = (timezoneStateQueries[location.timeZoneCode] ?? []).map(
      normalizeMatchText,
    );

    if (!stateName || !allowedStates.includes(normalizeMatchText(stateName))) {
      return 0;
    }
  }

  if (location.mode === 'timezone' && location.timeZoneCode) {
    const explicitStateCode =
      candidate.location?.stateCode ?? extractExplicitProfileStateCode(candidate);
    const stateName = explicitStateCode
      ? usStateNames[explicitStateCode as UsStateCode]
      : undefined;
    const allowedStates = (timezoneStateQueries[location.timeZoneCode] ?? []).map(
      normalizeMatchText,
    );

    if (stateName && !allowedStates.includes(normalizeMatchText(stateName))) {
      return 0;
    }
  }

  if (
    (location.mode === 'timezone' || location.mode === 'nationwide') &&
    (foreignLocationPattern.test(searchable) || foreignCityPattern.test(searchable))
  ) {
    return 0;
  }

  // A specific vertical must appear in the public result itself. This prevents
  // an owner from an unrelated industry slipping through a broad search page.
  if (!evidence.hasCategoryEvidence) {
    return 0;
  }

  // A mapped category must be visible in the profile identity, not only in a
  // search-engine snippet that may describe an unrelated page or employer.
  if (
    profile.key !== 'keyword-fallback' &&
    !evidence.hasCategoryIdentityEvidence &&
    !evidence.categoryRoleMatchedTerms.length &&
    !evidence.hasProfessionalTitleEvidence &&
    !(
      profile.key === 'ecommerce-brands' &&
      evidence.hasRoleEvidence &&
      /\b(?:at|of|for)\s+[a-z0-9]+(?:\s+[a-z0-9]+){0,5}\b/i.test(identitySearchable)
    )
  ) {
    return 0;
  }

  // A business-shaped identity without a person role or professional marker
  // is usually a company page published under a profile URL, not a lead.
  if (
    companyIdentityPattern.test(identitySearchable) &&
    !evidence.hasRoleEvidence &&
    !evidence.hasCredentialEvidence &&
    !evidence.hasProfessionalTitleEvidence
  ) {
    return 0;
  }

  // Education profiles can rank for local practitioner queries because their
  // institution name contains the requested category.
  if (
    profile.key !== 'schools' &&
    profile.key !== 'colleges' &&
    academicInstitutionPattern.test(identitySearchable)
  ) {
    return 0;
  }

  // Keep academic and training profiles out unless their identity also shows
  // a decision-making role for the requested business category.
  if (nonLeadContextPattern.test(identitySearchable) && !evidence.hasRoleEvidence) {
    return 0;
  }

  // Local searches should not accept a profile that the public result places in
  // another city, even when its category and role match the query.
  if (location.mode === 'local' && !evidence.hasLocationEvidence) {
    return 0;
  }

  let score = 35;
  score += evidence.hasCategoryEvidence ? 28 : 0;
  score += evidence.hasCategoryIdentityEvidence ? 8 : 0;
  score += Math.min(6, Math.max(0, evidence.categoryMatchedTerms.length - 1) * 3);
  score += evidence.hasRoleEvidence ? 16 : 0;
  score += evidence.ownerMatched ? 10 : 0;
  score += evidence.hasLocationEvidence ? 12 : 0;
  score += evidence.hasProfileEvidence ? 5 : 0;
  score += candidate.headline ? 3 : 0;
  score += candidate.snippet ? 2 : 0;

  // Keep profiles without an explicit public location available for recall,
  // but prefer results that prove their geographic fit in the public excerpt.
  if (location.mode === 'timezone' && !evidence.hasLocationEvidence) {
    score -= 10;
  }

  return Math.min(score, 100);
};

const calculateEvidenceBoost = (queryMatches: number, providerMatches: number) =>
  Math.min(8, Math.max(0, queryMatches - 1) * 2) +
  Math.min(6, Math.max(0, providerMatches - 1) * 3);

const getSecondPageQueryLimit = (requestedCount: number, availableQueryCount: number) =>
  Math.min(
    availableQueryCount,
    Math.min(12, Math.max(5, Math.ceil(requestedCount / 50) + 4)),
  );

const buildQueryVariants = (
  request: SearchRequest,
  location: NormalizedUsLocation,
  queryHints: string[] = [],
) => {
  const profile = resolveCategoryProfile(request.companyType);
  const isBroadLocation = location.mode === 'timezone' || location.mode === 'nationwide';
  const broadLocationLabel = normalizeMatchText(location.label);
  const discoveryQueries = buildDiscoveryQueryVariants(request.companyType, location, profile)
    .slice(0, getResearchDepthConfig(request.researchDepth).maxQueryFamilies)
    .flatMap((phrase, index) =>
      index < 4
        ? buildLinkedInProfilePathQueries(phrase)
        : [buildLinkedInQueryFromPhrase(phrase)],
    )
    .filter(
      (query) =>
        !isBroadLocation ||
        !broadLocationLabel ||
        !normalizeMatchText(query).includes(broadLocationLabel),
    );
  const companyTerms = buildCompanyTerms(request, profile);
  const aliasCompanyTerms = buildAliasCompanyTerms(request, profile);
  const locationTerms = buildLocationTerms(location);
  const { primary: genericRoleTerms, category: categoryRoleTerms } = buildRoleTerms(request, profile);

  const primaryCompany = selectPrimaryCompanyTerm(request, companyTerms);
  const secondaryCompany = selectSecondaryCompanyTerm(companyTerms, primaryCompany);
  const primaryLocation = locationTerms[0] ?? normalizeQueryTerm(location.label);
  const prioritizedRoleTerms = prioritizeRoleTerms(genericRoleTerms, categoryRoleTerms);
  const ownerRoleQueries = prioritizedRoleTerms
    .filter((role) => ownerRolePattern.test(role))
    .slice(0, 2)
    .map((role) => buildLinkedInQuery(primaryCompany, primaryLocation, role));
  const assistedQueries = unique(
    queryHints
      .map((hint) =>
        normalizeText(hint)
          .replace(/https?:\/\/\S+/gi, ' ')
          .replace(/\bsite:\S+/gi, ' ')
          .slice(0, 180),
      )
      .filter(Boolean),
  ).flatMap((hint) =>
    publicLinkedInProfilePaths.map((profilePath) =>
      buildLinkedInQueryFromPhrase(
        [hint, quoteQueryTerm(primaryLocation)].filter(Boolean).join(' '),
        profilePath,
      ),
    ),
  );
  const categoryCluster = buildBooleanQuery(companyTerms, 5);
  const roleCluster = buildBooleanQuery(prioritizedRoleTerms, 6);
  const highSignalClusters = publicLinkedInProfilePaths.flatMap((profilePath) => [
    buildLinkedInQueryFromPhrase(
      [categoryCluster, roleCluster, quoteQueryTerm(primaryLocation)].filter(Boolean).join(' '),
      profilePath,
    ),
    buildLinkedInQueryFromPhrase(
      [categoryCluster, quoteQueryTerm(primaryLocation)].filter(Boolean).join(' '),
      profilePath,
    ),
  ]);

  const roleQueries = [
    ...prioritizedRoleTerms.map((role, index) => {
      const company = index % 2 === 0 ? primaryCompany : secondaryCompany;

      return buildLinkedInQuery(company, primaryLocation, role);
    }),
    ...locationTerms.slice(1).map((locationTerm, index) => {
      const role = prioritizedRoleTerms[
        (index + 6) % Math.max(1, prioritizedRoleTerms.length)
      ];
      const company = index % 2 === 0 ? primaryCompany : secondaryCompany;

      return buildLinkedInQuery(company, locationTerm, role);
    }),
  ];
  const roleLedQueries = roleQueries
    .filter((query) => getLinkedInQueryFamily(query) === 'role-led')
    .slice(0, 1);

  const companyQueries = locationTerms.flatMap((locationTerm, index) => [
    buildLinkedInQuery(index % 2 === 0 ? primaryCompany : secondaryCompany, locationTerm),
  ]);

 const aliasQueries = locationTerms
   .slice(0, aliasCompanyTerms.length)
   .map((locationTerm, index) => {
     const alias = aliasCompanyTerms[index] ?? '';
     const role = prioritizedRoleTerms[(index + 6) % Math.max(1, prioritizedRoleTerms.length)];

     return buildLinkedInQuery(alias, locationTerm, role);
   });

 const legacyProfileQuery = buildLinkedInQueryFromPhrase(
   `${request.companyType} in ${primaryLocation}`,
   'pub',
 );
 const legacyRoleQueries = prioritizedRoleTerms.slice(0, 3).map((role) =>
   buildLinkedInQuery(primaryCompany, primaryLocation, role, 'pub'),
 );

  const queryCandidates = unique([
    ...highSignalClusters,
    ...assistedQueries,
    buildLinkedInQueryFromPhrase(`${request.companyType} in ${primaryLocation}`),
    ...roleLedQueries,
    ...aliasQueries,
    legacyProfileQuery,
    ...ownerRoleQueries,
    ...roleQueries,
    ...legacyRoleQueries,
    ...discoveryQueries.slice(0, 5),
    ...companyQueries.slice(0, 5),
    ...roleQueries.slice(10),
    ...discoveryQueries.slice(5),
    ...companyQueries.slice(5),
  ]);

  const minimumBudget =
    location.mode === 'timezone' || location.mode === 'nationwide' ? 16 : 13;
  const { queryMultiplier } = getResearchDepthConfig(request.researchDepth);
  const queryBudget = Math.min(
    maxQueries,
    Math.max(
      Math.ceil(minimumBudget * queryMultiplier),
      Math.ceil((Math.ceil(request.count / 35) + 8) * queryMultiplier),
    ),
  );

  return queryCandidates.slice(0, queryBudget);
};

const buildFallbackQueryVariants = (request: SearchRequest, location: NormalizedUsLocation) => {
  const profile = resolveCategoryProfile(request.companyType);
  const locationTerms = buildLocationTerms(location);
  const { primary: genericRoleTerms, category: categoryRoleTerms } = buildRoleTerms(request, profile);
  const fallbackRoleTerms = unique([...categoryRoleTerms, ...genericRoleTerms]);
  const companyTerms = buildCompanyTerms(request, profile);
  const primaryCompany = selectPrimaryCompanyTerm(request, companyTerms);
  const fallbackRoleOffsets = [3, 4, 5, 6, 9, 7, 8, 10, 11, 12];

  const fallbackCandidates = unique([
    ...locationTerms.flatMap((locationTerm, index) => {
      const roleOffset = fallbackRoleOffsets[index % fallbackRoleOffsets.length] ?? 3;
      const role = fallbackRoleTerms[roleOffset % Math.max(1, fallbackRoleTerms.length)];
      const company = companyTerms[(index + 1) % Math.max(1, Math.min(8, companyTerms.length))] ?? primaryCompany;

      return [
        buildLinkedInQuery(company, locationTerm, role),
        buildLinkedInQuery(company, locationTerm, role, 'pub'),
        buildLinkedInQueryFromPhrase(`${company} ${role ?? 'owner'} ${locationTerm}`),
      ];
    }),
  ]);

  const fallbackBudget = Math.min(
    maxQueries,
    Math.max(
      6,
      Math.ceil((Math.ceil(request.count / 50) + 6) * getResearchDepthConfig(request.researchDepth).queryMultiplier),
    ),
  );

  return fallbackCandidates.slice(0, fallbackBudget);
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
      const activeResult = current as SearchResult | null;
      if (activeResult?.snippet) {
        activeResult.snippet += ' ';
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
    const linkedProfileEntries = [...line.matchAll(
      /\[([^\]]+)\]\(([^)]+)\)/g,
    )]
      .map((match) => ({
        profileUrl: normalizeLinkedInProfileUrl(decodeUrl(match[2] ?? '')),
        title: stripMarkdown(match[1] ?? ''),
      }))
      .filter(
        (entry): entry is { profileUrl: string; title: string } => Boolean(entry.profileUrl),
      );
    const profileUrls = [
      ...new Set([
        ...linkedProfileEntries.map((entry) => entry.profileUrl),
        ...extractLinkedInProfileReferences(line, urls),
      ]),
    ];
    const visibleText = stripMarkdown(line);

    if (profileUrls.length) {
      flush();
      for (let index = 0; index < profileUrls.length; index += 1) {
        const profileUrl = profileUrls[index];
        if (!profileUrl) {
          continue;
        }

        const title =
          linkedProfileEntries.find((entry) => entry.profileUrl === profileUrl)?.title ||
          visibleText;
        const nextResult = {
          title,
          url: profileUrl,
          snippet: '',
        };

        if (index === profileUrls.length - 1) {
          current = nextResult;
        } else {
          results.push(nextResult);
        }
      }
      continue;
    }

    if (!current) {
      continue;
    }

    const activeResult = current as SearchResult;
    activeResult.snippet = `${activeResult.snippet} ${visibleText}`.trim();
  }

  flush();
  return results;
};

const parseDuckDuckGoResults = (html: string, decodeUrl: (value: string) => string) => {
  const results: SearchResult[] = [];
  const anchors = [
    ...html.matchAll(
      /<a\b[^>]*\bresult__a\b[^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ];

  anchors.forEach((match, index) => {
    const anchor = match[0] ?? '';
    const rawUrl = decodeHtmlEntities(
      anchor.match(/\bhref=["']([^"']+)["']/i)?.[1] ?? '',
    ).trim();
    const url = decodeUrl(rawUrl);
    if (!url) {
      return;
    }

    const start = (match.index ?? 0) + match[0].length;
    const end = anchors[index + 1]?.index ?? Math.min(html.length, start + 4_000);
    const resultTail = html.slice(start, end);
    const snippetMatch = resultTail.match(
      /class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i,
    );

    results.push({
      title: stripMarkdown(match[1] ?? ''),
      url,
      snippet: stripMarkdown(snippetMatch?.[1] ?? ''),
    });
  });

  return results;
};

const parseBingResults = (html: string, decodeUrl: (value: string) => string) => {
  const results: SearchResult[] = [];
  const resultBlocks = [
    ...html.matchAll(
      /<li\b[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'][\s\S]*?<\/li>/gi,
    ),
  ];

  for (const match of resultBlocks) {
    const block = match[0] ?? '';
    const anchor = block.match(
      /<h2\b[^>]*>[\s\S]*?<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i,
    );
    if (!anchor?.[1]) {
      continue;
    }

    const caption = block.match(
      /<div\b[^>]*\bclass=["'][^"']*\bb_caption\b[^"']*["'][\s\S]*?>([\s\S]*?)<\/div>/i,
    )?.[1];
    const snippet = block.match(
      /<div\b[^>]*\bclass=["'][^"']*\bb_caption\b[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i,
    )?.[1] ?? caption;

    results.push({
      title: stripMarkdown(anchor[2] ?? ''),
      url: decodeUrl(decodeHtmlEntities(anchor[1])),
      snippet: stripMarkdown(snippet ?? ''),
    });
  }

  // Keep tests and alternate Bing layouts tolerant while preferring the
  // native HTML parser for real public Bing result pages.
  return results.length ? results : parseMarkdownResults(html, decodeUrl);
};

const parseYahooResults = (html: string, decodeUrl: (value: string) => string) => {
  const results: SearchResult[] = [];
  const anchors = [
    ...html.matchAll(
      /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ];

  anchors.forEach((match, index) => {
    const rawUrl = decodeHtmlEntities(match[1] ?? '').trim();
    const url = decodeUrl(rawUrl);

    if (!isLinkedInProfileUrl(url)) {
      return;
    }

    const start = (match.index ?? 0) + match[0].length;
    const end = anchors[index + 1]?.index ?? Math.min(html.length, start + 4_000);
    const resultTail = html.slice(start, end);
    const snippetMatch = resultTail.match(
      /<(?:p|div)\b[^>]*\bclass=["'][^"']*(?:compText|aAbs|snippet|description)[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|div)>/i,
    );

    results.push({
      title: stripMarkdown(match[2] ?? ''),
      url,
      snippet: stripMarkdown(snippetMatch?.[1] ?? resultTail),
    });
  });

  return results;
};

const searchProvider = async (
  source: SearchSource,
  query: string,
  timeoutMs = searchTimeoutMs,
  page = 0,
): Promise<ProviderSearchResult> => {
  const cacheKey = `${source.name}:${page}:${query.toLowerCase()}`;
  const cached = getCachedProviderResult(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const body = await fetchTextWithTimeout(source.buildUrl(query, page), timeoutMs);
    if (isBlockedSearchBody(body)) {
      return {
        results: [] as SearchResult[],
        failure: 'blocked',
        message: `${source.label} returned a blocked or rate-limited page.`,
      };
    }

    const parsed =
      source.kind === 'duckduckgo-html'
        ? parseDuckDuckGoResults(body, source.decodeUrl)
        : source.kind === 'yahoo-html'
          ? parseYahooResults(body, source.decodeUrl)
        : source.kind === 'bing-html'
          ? parseBingResults(body, source.decodeUrl)
          : parseMarkdownResults(body, source.decodeUrl);
    const result = {
      results: parsed.filter((result) =>
        isLinkedInProfileUrl(result.url),
      ),
    };

    setCachedProviderResult(cacheKey, result);
    return result;
  } catch (error) {
    return {
      results: [] as SearchResult[],
      failure: 'fetch',
      message:
        error instanceof Error
          ? `${source.label} request failed: ${error.message}`
          : `${source.label} request failed.`,
    };
  }
};

const createProviderHealth = () =>
  new Map<string, ProviderHealth>(
    searchSources.map((source) => [
      source.name,
      {
        attempts: 0,
        failures: 0,
        blockedResponses: 0,
        disabled: false,
        lastMessage: '',
      },
    ]),
  );

const collectSearchResults = async (
  query: string,
  remainingResults: number,
  queryIndex: number,
  providerHealth: Map<string, ProviderHealth>,
  deadline: number,
  attemptedSearches: Set<string>,
  page = 0,
) => {
  const availableSources = searchSources.filter(
    (source) => !providerHealth.get(source.name)?.disabled,
  );

  if (!availableSources.length) {
    return [] as CollectedSearchResult[];
  }

  const remainingTimeMs = deadline - Date.now();
  if (remainingTimeMs <= 0) {
    return [] as CollectedSearchResult[];
  }

  const requestTimeoutMs = Math.min(searchTimeoutMs, remainingTimeMs);

  const rotatedSources = availableSources.map(
    (_, index) => availableSources[(index + queryIndex) % availableSources.length]!,
  );
  // Fan out only the first two high-signal paths so the shortlist gets
  // corroborating public evidence without multiplying every query.
  const sourceCount = queryIndex < 2 ? topQuerySourceCount : rotatingQuerySourceCount;
  const selectedSources = rotatedSources
    .slice(0, Math.min(sourceCount, rotatedSources.length))
    .filter((source) => {
      const requestKey = `${source.name}:${page}:${query.toLowerCase()}`;

      if (attemptedSearches.has(requestKey)) {
        return false;
      }

      attemptedSearches.add(requestKey);
      return true;
    });
  const resultSets = await Promise.all(
    selectedSources.map(async (source) => ({
      source,
      outcome: await searchProvider(source, query, requestTimeoutMs, page),
    })),
  );
  const collected: CollectedSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const { source, outcome } of resultSets) {
    const health = providerHealth.get(source.name);
    if (health) {
      health.attempts += 1;

      if (outcome.failure) {
        health.failures += 1;
        health.blockedResponses += Number(outcome.failure === 'blocked');
        health.lastMessage = outcome.message ?? `${source.label} search failed.`;
        health.disabled = health.failures >= providerFailureThreshold;
      }
    }

    for (const result of outcome.results) {
      if (collected.length >= remainingResults) {
        break;
      }

      const profileUrl = normalizeLinkedInProfileUrl(result.url);
      const dedupeKey = profileUrl ?? result.url;
      if (seenUrls.has(dedupeKey)) {
        continue;
      }

      seenUrls.add(dedupeKey);
      collected.push({ ...result, providerName: source.name });
    }
  }

  return collected;
};

const buildProviderHealthWarnings = (providerHealth: Map<string, ProviderHealth>) =>
  searchSources.flatMap((source) => {
    const health = providerHealth.get(source.name);
    if (!health || !health.failures) {
      return [];
    }

    const allProvidersDisabled = [...providerHealth.values()].every(
      (provider) => provider.disabled,
    );
    const status = health.disabled
      ? 'was paused after repeated failures'
      : 'was unavailable for part of this search';
    const continuation = allProvidersDisabled
      ? 'No public-search fallback remained available.'
      : 'Discovery continued with available fallback providers.';

    return [
      {
        providerId: `${providerId}-${source.name}`,
        providerName: source.label,
        message: `${source.label} ${status} (${health.failures}/${health.attempts} attempts). ${continuation}`,
      },
    ];
  });

const parseLinkedInTitle = (title: string, profileUrl: string) => {
  const slugName = slugToName(profileUrl);
  const cleaned = normalizeText(
    decodeHtmlEntities(title)
      .replace(/^\s*\d+[.)]\s*/, '')
      .replace(/^.*?(?:[a-z0-9-]+\.)?linkedin\.com\s*›\s*(?:in|pub)\s*›\s*[^ ]+\s+/i, '')
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

  const titleName = segments[0] ?? '';
  const titleStartsWithHeadline = decisionMakerPattern.test(titleName);
  const name = isLikelyPersonName(titleName)
    ? titleName
    : isLikelyPersonName(slugName)
      ? slugName
      : titleName || slugName || cleaned;
  const headline = normalizeText(
    titleStartsWithHeadline ? cleaned : segments.slice(1).join(' - '),
  );

  return {
    name,
    headline: headline || undefined,
  };
};

const toLeadConfidence = (candidate: LinkedInCandidate) => {
  let score = 52 + Math.round(candidate.relevanceScore * 0.3);

  if (candidate.name) score += 10;
  if (candidate.headline) score += 8;
  if (candidate.snippet) score += 4;
  if (candidate.profileUrl.includes('/in/') || candidate.profileUrl.includes('/pub/')) score += 10;
  if (hasLinkedInProfileSignals(candidate.title)) score += 5;
  if (hasLinkedInProfileSignals(candidate.snippet)) score += 3;

  const cappedScore = Math.min(score, 98);

  return candidate.location ? cappedScore : Math.max(0, cappedScore - 10);
};

const limitPublicEvidence = (value: string | undefined, maxLength: number) => {
  const normalized = normalizeText(value);

  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxLength
    ? normalized.slice(0, maxLength - 3).trimEnd() + '...'
    : normalized;
};

const mergePublicEvidence = (
  existing: LinkedInEvidenceSource[],
  incoming: LinkedInEvidenceSource[],
) => {
  const merged = new Map<string, LinkedInEvidenceSource>();

  [...existing, ...incoming].forEach((evidence) => {
    const key = evidence.providerName.toLowerCase();
    const previous = merged.get(key);

    if (!previous) {
      merged.set(key, { ...evidence });
      return;
    }

    merged.set(key, {
      providerName: previous.providerName,
      title: evidence.title.length > previous.title.length ? evidence.title : previous.title,
      snippet:
        evidence.snippet.length > previous.snippet.length
          ? evidence.snippet
          : previous.snippet,
    });
  });

  return [...merged.values()];
};

const formerEmploymentPattern =
  /\b(former|ex[- ]|previously|past)\b/i;
const currentEmploymentPattern =
  /\b(currently|current role|present|serving as|works? as|working as)\b/i;
const activeRoleContextPattern =
  /\b(founder|co-founder|owner|co-owner|ceo|president|principal|partner|director|manager|operator|administrator|head of|vice president|vp)\b[^.]{0,80}\b(?:at|@|of|for)\b/i;

/**
 * Employment status is deliberately conservative: public snippets rarely
 * prove a current job, so role wording without an explicit current marker is
 * reported as probable rather than confirmed.
 */
export const inferPublicEmploymentStatus = (publicProfileText: string): EmploymentStatus => {
  const text = normalizeText(publicProfileText);
  const hasFormerSignal = formerEmploymentPattern.test(text);
  const hasCurrentSignal = currentEmploymentPattern.test(text);
  const hasActiveRoleContext = activeRoleContextPattern.test(text);

  if (hasFormerSignal && hasCurrentSignal) {
    return 'conflicting';
  }

  if (hasFormerSignal) {
    return 'former';
  }

  if (hasCurrentSignal) {
    return 'current';
  }

  if (hasActiveRoleContext) {
    return 'probable';
  }

  return 'unverified';
};

const buildLeadFromCandidate = (
  candidate: LinkedInCandidate,
  request: SearchRequest,
  location: NormalizedUsLocation,
): Lead => {
  const publicLocation = candidate.location;
  const profileTitle = limitPublicEvidence(candidate.title, 240);
  const profileSnippet = limitPublicEvidence(candidate.snippet, 360);
  const publicEvidenceSources = candidate.publicEvidence
    .map((evidence) => {
      const profileTitle = limitPublicEvidence(evidence.title, 240);
      const profileSnippet = limitPublicEvidence(evidence.snippet, 360);

      return {
        providerName:
          searchSources.find((source) => source.name === evidence.providerName)?.label ??
          evidence.providerName,
        profileTitle,
        profileSnippet,
      };
    })
    .filter((evidence) => evidence.profileTitle || evidence.profileSnippet);
  const publicEvidence = profileTitle || profileSnippet || publicEvidenceSources.length
    ? { profileTitle, profileSnippet, sources: publicEvidenceSources }
    : undefined;
  const publicProfileText = normalizeText(
    `${candidate.title} ${candidate.headline ?? ''} ${candidate.snippet}`,
  );

  return {
    id: createId(candidate.profileUrl || `${candidate.name}-${candidate.headline ?? ''}`),
    name: normalizeText(candidate.name || slugToName(candidate.profileUrl) || candidate.profileUrl),
    headline: candidate.headline,
    employmentStatus: inferPublicEmploymentStatus(publicProfileText),
    mobile: '',
    email: '',
    website: candidate.website ?? '',
    publicEvidence,
    category: request.companyType,
    city: publicLocation?.city || location.city || location.label,
    stateCode: publicLocation?.stateCode || location.stateCode,
    address: publicLocation?.label ?? '',
    source: leadSourceLabel,
    confidence: toLeadConfidence(candidate),
    sourceScore: 86,
    matchSignals: {
      queryMatches: candidate.matchedQueries.length,
      publicSources: candidate.matchedProviders.length,
      publicProviderNames: candidate.matchedProviders.map(
        (name) => searchSources.find((source) => source.name === name)?.label ?? name,
      ),
      categoryMatchedTerms: candidate.matchedCategoryTerms,
      roleMatchedTerms: candidate.matchedRoleTerms,
      queryFamilies: candidate.matchedQueryFamilies,
      locationEvidence: publicLocation?.label,
      categoryMatched: candidate.matchedCategoryTerms.length > 0,
      ownerMatched: candidate.matchedRoleTerms.some(isOwnerRoleTerm),
      roleMatched: candidate.matchedRoleTerms.length > 0,
      locationMatched: Boolean(publicLocation),
    },
    listingUrl: candidate.profileUrl,
    hasEmail: false,
    hasPhone: false,
    hasWebsite: Boolean(candidate.website),
    verifiedPhone: false,
    verifiedEmail: false,
    scrapedAt: new Date().toISOString(),
  };
};

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

const runLinkedInQuerySet = async ({
  queries,
  candidates,
  maxResults,
  deadline,
  request,
  location,
  providerHealth,
  attemptedSearches,
  queryOffset = 0,
  page = 0,
}: {
  queries: string[];
  candidates: Map<string, LinkedInCandidate>;
  maxResults: number;
  deadline: number;
  request: SearchRequest;
  location: NormalizedUsLocation;
  providerHealth: Map<string, ProviderHealth>;
  attemptedSearches: Set<string>;
  queryOffset?: number;
  page?: number;
}) => {
  let queriesAttempted = 0;
  const queryFamilies = new Set<string>();
  const queryFamilyCounts = new Map<string, number>();

  const addQueryResults = (queryResults: CollectedSearchResult[], query: string) => {
    const queryKey = query.toLowerCase();

    for (const result of queryResults) {
      if (Date.now() >= deadline || candidates.size >= maxResults) {
        break;
      }

      const profileUrl = normalizeLinkedInProfileUrl(result.url);
      if (!profileUrl) {
        continue;
      }

      const { name, headline } = parseLinkedInTitle(result.title, profileUrl);
      const candidateWithoutScore = {
        title: result.title,
        name,
        headline,
        profileUrl,
        website: extractPublicWebsite(result.title, result.snippet),
        snippet: normalizeText(result.snippet),
        publicEvidence: [
          {
            providerName: result.providerName,
            title: normalizeText(result.title),
            snippet: normalizeText(result.snippet),
          },
        ],
        location: extractPublicProfileLocation({
          title: result.title,
          headline,
          snippet: normalizeText(result.snippet),
        }, location),
      };
      const evidence = getCandidateMatchEvidence(candidateWithoutScore, request, location);
      const candidateWithEvidence = {
        ...candidateWithoutScore,
        matchedCategoryTerms: evidence.categoryMatchedTerms,
        matchedRoleTerms: evidence.roleMatchedTerms,
        matchedLocationTerms: evidence.locationMatchedTerms,
        matchedQueryFamilies: [getLinkedInQueryFamily(query)],
      };
      const relevanceScore = scoreCandidateRelevance(
        candidateWithEvidence,
        request,
        location,
        evidence,
      );

      if (relevanceScore < 60) {
        continue;
      }

      const existing = candidates.get(profileUrl);
      if (existing) {
        const matchedQueries = existing.matchedQueries.includes(queryKey)
          ? existing.matchedQueries
          : [...existing.matchedQueries, queryKey];
        const matchedProviders = existing.matchedProviders.includes(result.providerName)
          ? existing.matchedProviders
          : [...existing.matchedProviders, result.providerName];
        const baseRelevanceScore = Math.max(existing.baseRelevanceScore, relevanceScore);

        candidates.set(profileUrl, {
          ...existing,
          title:
            candidateWithEvidence.title.length > existing.title.length
              ? candidateWithEvidence.title
              : existing.title,
          headline:
            (candidateWithEvidence.headline?.length ?? 0) > (existing.headline?.length ?? 0)
              ? candidateWithEvidence.headline
              : existing.headline,
          website: candidateWithEvidence.website || existing.website,
          snippet:
            candidateWithEvidence.snippet.length > existing.snippet.length
              ? candidateWithEvidence.snippet
              : existing.snippet,
          publicEvidence: mergePublicEvidence(
            existing.publicEvidence,
            candidateWithEvidence.publicEvidence,
          ),
          location: candidateWithEvidence.location ?? existing.location,
          matchedCategoryTerms: unique([
            ...existing.matchedCategoryTerms,
            ...candidateWithEvidence.matchedCategoryTerms,
          ]),
          matchedRoleTerms: unique([
            ...existing.matchedRoleTerms,
            ...candidateWithEvidence.matchedRoleTerms,
          ]),
          matchedLocationTerms: unique([
            ...existing.matchedLocationTerms,
            ...candidateWithEvidence.matchedLocationTerms,
          ]),
          matchedQueryFamilies: unique([
            ...existing.matchedQueryFamilies,
            ...candidateWithEvidence.matchedQueryFamilies,
          ]),
          baseRelevanceScore,
          matchedQueries,
          matchedProviders,
          relevanceScore: Math.min(
            100,
            baseRelevanceScore +
              calculateEvidenceBoost(matchedQueries.length, matchedProviders.length),
          ),
        });
        continue;
      }

      candidates.set(profileUrl, {
        ...candidateWithEvidence,
        baseRelevanceScore: relevanceScore,
        relevanceScore,
        matchedQueries: [queryKey],
        matchedProviders: [result.providerName],
      });
    }
  };

  let batchStart = 0;

  while (batchStart < queries.length) {
    if (Date.now() >= deadline || candidates.size >= maxResults) {
      break;
    }

    if ([...providerHealth.values()].every((health) => health.disabled)) {
      break;
    }

    // Keep bounded query parallelism even after an isolated provider failure.
    // collectSearchResults re-evaluates healthy sources for every query, while
    // the provider circuit breaker still pauses a source after its threshold.
    const batch = queries.slice(batchStart, batchStart + queryBatchSize);
    batch.forEach((query) => {
      const family = getLinkedInQueryFamily(query);
      queryFamilies.add(family);
      queryFamilyCounts.set(family, (queryFamilyCounts.get(family) ?? 0) + 1);
    });
    const resultSets = await Promise.all(
      batch.map((query, batchIndex) =>
        collectSearchResults(
          query,
          maxResults - candidates.size,
          queryOffset + batchStart + batchIndex,
          providerHealth,
          deadline,
          attemptedSearches,
          page,
        ),
      ),
    );
    queriesAttempted += batch.length;

    // Preserve query order while merging concurrent responses for deterministic
    // ranking and stable duplicate handling.
    resultSets.forEach((queryResults, index) =>
      addQueryResults(queryResults, batch[index] ?? ''),
    );
    batchStart += batch.length;
  }

  return {
    queriesAttempted,
    queryFamilies: [...queryFamilies],
    queryFamilyCounts: Object.fromEntries(queryFamilyCounts),
  };
};

export const discoverUsLeadsFromLinkedinSearch = async ({
  request,
  location,
  deadlineMs,
  queryHints = [],
}: {
  request: SearchRequest;
  location: NormalizedUsLocation;
  deadlineMs?: number;
  queryHints?: string[];
}): Promise<LinkedInDiscoveryResult> => {
  const start = Date.now();
  const deadline = deadlineMs ?? start + 28_000;
  const queries = buildQueryVariants(request, location, queryHints);
  const primaryQueryKeys = new Set(queries.map((query) => query.toLowerCase()));
  const fallbackQueries = buildFallbackQueryVariants(request, location).filter(
    (query) => !primaryQueryKeys.has(query.toLowerCase()),
  );
  const candidateBudget = getCandidateBudget(request.count, request.researchDepth);
  const configuredMaxResults = readBoundedNumber(
    process.env.LINKEDIN_SEARCH_MAX_RESULTS,
    candidateBudget,
    1,
    candidateBudget,
  );
  const maxResults = Math.min(candidateBudget, configuredMaxResults);
  const candidates = new Map<string, LinkedInCandidate>();
  const warnings: ProviderWarning[] = [];
  const providerHealth = createProviderHealth();
  const attemptedSearches = new Set<string>();

  const primaryRun = await runLinkedInQuerySet({
    queries,
    candidates,
    maxResults,
    deadline,
    request,
    location,
    providerHealth,
    attemptedSearches,
  });

  let fallbackQueriesAttempted = 0;
  let secondPageQueriesAttempted = 0;
  const queryFamilies = new Set(primaryRun.queryFamilies);
  const queryFamilyCounts = new Map(Object.entries(primaryRun.queryFamilyCounts));
  const mergeQueryFamilyCounts = (counts: Record<string, number>) => {
    Object.entries(counts).forEach(([family, count]) => {
      queryFamilyCounts.set(family, (queryFamilyCounts.get(family) ?? 0) + count);
    });
  };

  if (candidates.size < maxResults && Date.now() < deadline) {
    const fallbackRun = await runLinkedInQuerySet({
      queries: fallbackQueries,
      candidates,
      maxResults,
      deadline,
      request,
      location,
      providerHealth,
      attemptedSearches,
      queryOffset: primaryRun.queriesAttempted,
    });
    fallbackQueriesAttempted = fallbackRun.queriesAttempted;
    fallbackRun.queryFamilies.forEach((family) => queryFamilies.add(family));
    mergeQueryFamilyCounts(fallbackRun.queryFamilyCounts);
  }

  // Public search engines expose more than one result page. Only request a
  // bounded second page after query variants are exhausted. Larger requests
  // get a wider window, while the hard cap, deadline, and provider circuit
  // breakers keep public-search traffic predictable.
  const paginationQueries = unique([...queries, ...fallbackQueries]);
  const depthConfig = getResearchDepthConfig(request.researchDepth);
  const secondPageQueryLimit = Math.min(
    depthConfig.secondPageQueryLimit,
    getSecondPageQueryLimit(request.count, paginationQueries.length),
  );
  if (
    secondPageQueryLimit > 0 &&
    candidates.size < maxResults &&
    Date.now() < deadline &&
    [...providerHealth.values()].some((health) => !health.disabled)
  ) {
    const secondPageRun = await runLinkedInQuerySet({
      queries: paginationQueries.slice(0, secondPageQueryLimit),
      candidates,
      maxResults,
      deadline,
      request,
      location,
      providerHealth,
      attemptedSearches,
      queryOffset: primaryRun.queriesAttempted + fallbackQueriesAttempted,
      page: 1,
    });
    secondPageQueriesAttempted = secondPageRun.queriesAttempted;
    secondPageRun.queryFamilies.forEach((family) => queryFamilies.add(family));
    mergeQueryFamilyCounts(secondPageRun.queryFamilyCounts);
  }

  buildProviderHealthWarnings(providerHealth).forEach((warning) =>
    pushUniqueWarning(warnings, warning),
  );

  const leads = [...candidates.values()]
    .sort(
      (left, right) =>
        right.relevanceScore - left.relevanceScore ||
        left.name.localeCompare(right.name),
    )
    .slice(0, request.count)
    .map((candidate) => buildLeadFromCandidate(candidate, request, location));

  const blocked =
    !leads.length && [...providerHealth.values()].every((health) => health.disabled);

  if (!leads.length && !blocked) {
    warnings.push(buildNoResultsWarning(location.label));
  }

  return {
    leads,
    warnings,
    blocked,
    coverage: {
      queriesAttempted:
        primaryRun.queriesAttempted + fallbackQueriesAttempted + secondPageQueriesAttempted,
      providersChecked: [...providerHealth.values()].filter((health) => health.attempts > 0)
        .length,
      providersPaused: [...providerHealth.values()].filter((health) => health.disabled).length,
      acceptedCandidates: candidates.size,
      queryFamilies: [...queryFamilies],
      queryFamilyCounts: Object.fromEntries(queryFamilyCounts),
    },
  };
};

export const buildLinkedinSearchWarning = buildNoResultsWarning;
