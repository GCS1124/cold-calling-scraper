import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';
import type { NormalizedUsLocation } from './us-location';
import { enrichLead } from './lead-validation';
import {
  enrichLeadFromWebsite,
  extractContactDetailsFromHtml,
  isPublicHttpUrl,
} from './website-enrichment';
import { buildDiscoverySeeds } from './discovery-seeds';

type PublicSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type ContactSearchSource = {
  name: string;
  label: string;
  kind: 'markdown' | 'bing-html' | 'duckduckgo-html';
  buildUrl: (query: string) => string;
  decodeUrl: (value: string) => string;
};

type ContactProviderHealth = {
  attempts: number;
  failures: number;
  blockedResponses: number;
  disabled: boolean;
};

type PublicContactEnrichmentResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  enrichedCount: number;
};

const providerId = 'linkedin-public-contact-enrichment';
const providerName = 'Public Contact Search';
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

const searchTimeoutMs = readBoundedNumber(
  process.env.LINKEDIN_CONTACT_SEARCH_TIMEOUT_MS,
  3_500,
  500,
  15_000,
);
const concurrency = readBoundedNumber(
  process.env.LINKEDIN_CONTACT_ENRICHMENT_CONCURRENCY,
  6,
  1,
  10,
);

const blockedBodyPatterns = [
  /(?:captcha|human verification)\s+(?:is\s+)?required/i,
  /too many requests/i,
  /unusual traffic/i,
  /verify.*not a bot/i,
  /access denied/i,
  /temporarily blocked/i,
  /cf-chl|just a moment/i,
  /bots use duckduckgo/i,
];

const providerFailureThreshold = 2;
const queryCacheTtlMs = 15 * 60 * 1000;
const maxQueryCacheEntries = 300;
const maxWebsiteCandidates = 3;

const queryCache = new Map<
  string,
  { expiresAt: number; results: PublicSearchResult[] }
>();

const excludedHosts = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'facebook.com',
  'www.facebook.com',
  'instagram.com',
  'www.instagram.com',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'tiktok.com',
  'www.tiktok.com',
  'youtube.com',
  'www.youtube.com',
  'yelp.com',
  'www.yelp.com',
  'yellowpages.com',
  'www.yellowpages.com',
  'mapquest.com',
  'www.mapquest.com',
  'superpages.com',
  'www.superpages.com',
  'manta.com',
  'www.manta.com',
  'chamberofcommerce.com',
  'www.chamberofcommerce.com',
  'zoominfo.com',
  'www.zoominfo.com',
  'crunchbase.com',
  'www.crunchbase.com',
  'indeed.com',
  'www.indeed.com',
  'glassdoor.com',
  'www.glassdoor.com',
  'whitepages.com',
  'www.whitepages.com',
  'yahoo.com',
  'www.yahoo.com',
  'angi.com',
  'www.angi.com',
  'bbb.org',
  'www.bbb.org',
  'birdeye.com',
  'www.birdeye.com',
  'citysearch.com',
  'www.citysearch.com',
  'doximity.com',
  'www.doximity.com',
  'doctor.com',
  'www.doctor.com',
  'healthgrades.com',
  'www.healthgrades.com',
  'homeadvisor.com',
  'www.homeadvisor.com',
  'houzz.com',
  'www.houzz.com',
  'merchantcircle.com',
  'www.merchantcircle.com',
  'opencare.com',
  'www.opencare.com',
  'porch.com',
  'www.porch.com',
  'ratemds.com',
  'www.ratemds.com',
  'thumbtack.com',
  'www.thumbtack.com',
  'vitals.com',
  'www.vitals.com',
  'webmd.com',
  'www.webmd.com',
  'zocdoc.com',
  'www.zocdoc.com',
  'r.jina.ai',
  'search.brave.com',
  'bing.com',
  'www.bing.com',
  'duckduckgo.com',
  'www.duckduckgo.com',
  'html.duckduckgo.com',
  'google.com',
  'www.google.com',
]);

const ignoredExtensions = /\.(?:pdf|png|jpe?g|gif|webp|svg|css|js|json|xml|zip)(?:$|[?#])/i;

const searchSources: ContactSearchSource[] = [
  {
    name: 'brave',
    label: 'Brave Search',
    kind: 'markdown',
    buildUrl: (query: string) =>
      `https://r.jina.ai/http://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
    decodeUrl: (value: string) => value,
  },
  {
    name: 'bing',
    label: 'Bing',
    kind: 'bing-html',
    buildUrl: (query: string) =>
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=US&setlang=en-us&mkt=en-US`,
    decodeUrl: (value: string) => decodeBingUrl(value),
  },
  {
    name: 'duckduckgo',
    label: 'DuckDuckGo',
    kind: 'duckduckgo-html',
    buildUrl: (query: string) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    decodeUrl: (value: string) => decodeDuckDuckGoUrl(value),
  },
] as const;

const normalizeText = (value?: string | null) =>
  (value ?? '').replace(/\s+/g, ' ').trim();

const normalizeIdentityText = (value?: string | null) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
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
  Array.from(
    value.matchAll(publicWebsiteTokenPattern),
    (match) => match[0].replace(/[.,;:]+$/, ''),
  );

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

const normalizeWebsite = (value: string) => {
  try {
    const candidateUrl = /^(?:https?:\/\/)/i.test(value)
      ? value
      : `https://${value}`;
    const url = new URL(candidateUrl);
    url.hash = '';

    if (!/^https?:$/i.test(url.protocol)) {
      return '';
    }

    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
    }

    return url.toString();
  } catch {
    return '';
  }
};

const isExcludedHost = (value: string) => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    const withoutWww = hostname.replace(/^www\./, '');

    return (
      excludedHosts.has(hostname) ||
      excludedHosts.has(withoutWww) ||
      withoutWww.endsWith('.linkedin.com') ||
      withoutWww.endsWith('.yahoo.com') ||
      withoutWww.endsWith('.yelp.com') ||
      withoutWww.endsWith('.yellowpages.com') ||
      withoutWww.endsWith('.healthgrades.com') ||
      withoutWww.endsWith('.opencare.com') ||
      withoutWww.endsWith('.zocdoc.com') ||
      withoutWww === 'wikipedia.org' ||
      withoutWww.endsWith('.wikipedia.org') ||
      withoutWww.endsWith('.search.brave.com') ||
      withoutWww.endsWith('.bing.com') ||
      withoutWww.endsWith('.google.com')
    );
  } catch {
    return true;
  }
};

const isCandidateWebsite = (value: string) => {
  const normalized = normalizeWebsite(value);

  if (!normalized || isExcludedHost(normalized)) {
    return '';
  }

  if (!isPublicHttpUrl(normalized)) {
    return '';
  }

  try {
    const url = new URL(normalized);

    if (ignoredExtensions.test(url.pathname)) {
      return '';
    }

    return normalized;
  } catch {
    return '';
  }
};

const parsePublicSearchResults = (
  markdown: string,
  decodeUrl: (value: string) => string,
) => {
  const results: PublicSearchResult[] = [];
  const lines = markdown.split(/\r?\n/);
  let current: PublicSearchResult | null = null;

  const flush = () => {
    if (current) {
      results.push({
        ...current,
        title: normalizeText(current.title),
        snippet: normalizeText(current.snippet),
      });
    }

    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
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

    const website = extractUrls(line)
      .map((url) => decodeUrl(url))
      .map(isCandidateWebsite)
      .find(Boolean);
    const visibleText = stripMarkdown(line);

    if (website) {
      flush();
      current = {
        title: visibleText,
        url: website,
        snippet: '',
      };
      continue;
    }

    if (current) {
      current.snippet = `${current.snippet} ${visibleText}`.trim();
    }
  }

  flush();
  return results;
};

const parseDuckDuckGoResults = (html: string, decodeUrl: (value: string) => string) => {
  const results: PublicSearchResult[] = [];
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
  const results: PublicSearchResult[] = [];
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

  // Keep markdown fixtures and alternate result layouts supported while using
  // the native parser for real public Bing pages.
  return results.length ? results : parsePublicSearchResults(html, decodeUrl);
};

const fetchTextWithTimeout = async (url: string, timeoutMs = searchTimeoutMs) => {
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

const getCachedSearchResults = (key: string) => {
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

  return cached.results;
};

const setCachedSearchResults = (key: string, results: PublicSearchResult[]) => {
  // A temporary empty provider response must not suppress later website
  // lookups for the same public profile.
  if (process.env.NODE_ENV === 'test' || !results.length) {
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
    results,
  });
};

const createContactProviderHealth = () =>
  new Map<string, ContactProviderHealth>(
    searchSources.map((source) => [
      source.name,
      {
        attempts: 0,
        failures: 0,
        blockedResponses: 0,
        disabled: false,
      },
    ]),
  );

const searchPublicWebsiteSource = async (
  source: ContactSearchSource,
  query: string,
  providerHealth: Map<string, ContactProviderHealth>,
  timeoutMs = searchTimeoutMs,
) => {
  const health = providerHealth.get(source.name);
  if (health?.disabled) {
    return [] as PublicSearchResult[];
  }

  const cacheKey = `${source.name}:${query.toLowerCase()}`;
  const cached = getCachedSearchResults(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const body = await fetchTextWithTimeout(source.buildUrl(query), timeoutMs);
    if (health) {
      health.attempts += 1;
    }

    if (blockedBodyPatterns.some((pattern) => pattern.test(body))) {
      if (health) {
        health.failures += 1;
        health.blockedResponses += 1;
        health.disabled = health.failures >= providerFailureThreshold;
      }
      return [] as PublicSearchResult[];
    }

    const results =
      source.kind === 'duckduckgo-html'
        ? parseDuckDuckGoResults(body, source.decodeUrl)
        : source.kind === 'bing-html'
          ? parseBingResults(body, source.decodeUrl)
          : parsePublicSearchResults(body, source.decodeUrl);
    setCachedSearchResults(cacheKey, results);
    return results;
  } catch {
    if (health) {
      health.attempts += 1;
      health.failures += 1;
      health.disabled = health.failures >= providerFailureThreshold;
    }
    return [] as PublicSearchResult[];
  }
};

const buildProviderHealthWarnings = (
  providerHealth: Map<string, ContactProviderHealth>,
) =>
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
      ? 'No public contact-search fallback remained available.'
      : 'Contact discovery continued with available fallback providers.';

    return [
      buildWarning(
        source.label,
        `${source.label} ${status} (${health.failures}/${health.attempts} attempts). ${continuation}`,
      ),
    ];
  });

const addSourceTag = (source: string, tag: string) => {
  const parts = source
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.includes(tag)) {
    parts.push(tag);
  }

  return parts.join(', ');
};

const buildWarning = (sourceLabel: string, message: string): ProviderWarning => ({
  providerId: `${providerId}-${sourceLabel.toLowerCase().replace(/\s+/g, '-')}`,
  providerName: sourceLabel,
  message,
});

const roleOnlyHeadlinePattern =
  /^(?:founder|co-founder|owner|ceo|president|principal|partner|director|manager|operator|dentist|doctor|physician|contractor|realtor|attorney|lawyer|consultant|dds|dmd|md|do|rn|dvm|phd|cpa|esq|jd|mba|(?:[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})\s+(?:manager|director|partner|administrator|advisor|consultant|superintendent|controller|executive|officer|owner|founder))$/i;

const headlineRolePrefixPattern =
  /^(?:(?:co-)?founder|owner operator|business owner|practice owner|clinic owner|franchise owner|owner|chief executive officer|ceo|president|managing partner|partner|principal|director|general manager|operations manager|office manager|practice manager|service manager|store manager|operator|dentist|doctor|physician|contractor|realtor|attorney|lawyer|consultant|(?:[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})\s+(?:manager|director|partner|administrator|advisor|consultant|superintendent|controller|executive|officer|owner|founder))(?:\s+|\s*[,;:/|–—-]\s*)(.+)$/i;

const extractOrganizationHint = (headline: string, category: string) => {
  const normalizedHeadline = normalizeText(headline);
  const candidates = [
    normalizedHeadline.match(/\b(?:at|with|for|of)\s+(.+)$/i)?.[1] ?? '',
    normalizedHeadline.match(/\s[-|]\s(.+)$/)?.[1] ?? '',
    headlineRolePrefixPattern.exec(normalizedHeadline)?.[1] ?? '',
  ];

  for (const candidate of candidates) {
    const organization = normalizeText(candidate)
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/\s*[|]\s*linkedin.*$/i, '')
      .trim();

    if (
      organization.length >= 4 &&
      organization.length <= 100 &&
      !roleOnlyHeadlinePattern.test(organization) &&
      normalizeIdentityText(organization) !== normalizeIdentityText(category)
    ) {
      return organization;
    }
  }

  if (
    normalizedHeadline.length >= 4 &&
    normalizedHeadline.length <= 100 &&
    !roleOnlyHeadlinePattern.test(normalizedHeadline) &&
    normalizeIdentityText(normalizedHeadline) !== normalizeIdentityText(category)
  ) {
    return normalizedHeadline;
  }

  return '';
};

const buildQueries = (
  lead: Lead,
  request: SearchRequest,
  location: NormalizedUsLocation,
) => {
  const name = normalizeText(lead.name).replace(/["'`]+/g, ' ');
  const headline = normalizeText(lead.headline).replace(/["'`]+/g, ' ');
  const category = normalizeText(request.companyType || lead.category).replace(/["'`]+/g, ' ');
  const city = normalizeText(location.label || lead.city).replace(/["'`]+/g, ' ');
  const leadCity = normalizeText(lead.city).replace(/,\s*[A-Z]{2}$/i, '');
  const preciseLeadLocation =
    location.mode === 'timezone' &&
    leadCity.toLowerCase() !== normalizeText(location.label).toLowerCase()
      ? normalizeText([leadCity, lead.stateCode].filter(Boolean).join(', '))
      : '';

  if (!name || !city) {
    return [];
  }

  const organization = extractOrganizationHint(headline, category);
  const locationTerms =
    location.mode === 'local'
      ? [location.label, location.city].filter(Boolean)
      : location.mode === 'nationwide'
        ? ['United States']
        : [preciseLeadLocation, ...buildDiscoverySeeds(location)].filter(Boolean).slice(0, 4);
  const primaryLocation = normalizeText(locationTerms[0] ?? '')
    .replace(/["'`]+/g, ' ')
    .trim();
  const secondaryLocation = normalizeText(locationTerms[1] ?? primaryLocation)
    .replace(/["'`]+/g, ' ')
    .trim();
  const identity = `"${name}" "${headline || category}"`;

  return [
    `${identity} contact phone email -site:linkedin.com`,
    `${identity} "${primaryLocation}" phone email -site:linkedin.com`,
    organization
      ? `"${organization}" "${secondaryLocation}" official website phone email -site:linkedin.com`
      : `"${name}" "${category}" "${secondaryLocation}" official website -site:linkedin.com`,
  ];
};

const scoreResult = (
  result: PublicSearchResult,
  lead: Lead,
  request: SearchRequest,
  location: NormalizedUsLocation,
) => {
  const searchable = normalizeIdentityText(`${result.title} ${result.snippet} ${result.url}`);
  const compactSearchable = searchable.replace(/\s+/g, '');
  const name = normalizeIdentityText(lead.name);
  const nameParts = name.split(' ').filter((part) => part.length >= 3);
  const matchedNameParts = nameParts.filter((part) => searchable.includes(part));
  const surname = nameParts[nameParts.length - 1] ?? '';
  const headline = normalizeText(lead.headline);
  const organization = normalizeIdentityText(
    extractOrganizationHint(headline, normalizeText(request.companyType || lead.category)),
  );
  const compactOrganization = organization.replace(/\s+/g, '');
  const hasOrganizationEvidence =
    organization.length >= 5 &&
    (searchable.includes(organization) || compactSearchable.includes(compactOrganization));
  const category = normalizeIdentityText(request.companyType || lead.category);
  const city = normalizeIdentityText(location.city || location.label);

  let score = 0;

  if (name.length >= 5 && searchable.includes(name)) {
    score += 60;
  } else if (matchedNameParts.length >= 2) {
    score += 42;
  } else if (surname.length >= 4 && searchable.includes(surname)) {
    score += 24;
  }

  score += hasOrganizationEvidence ? 52 : 0;
  score += category && searchable.includes(category) ? 10 : 0;
  score += city && searchable.includes(city) ? 6 : 0;

  if (/contact|about|service|appointment/i.test(`${result.title} ${result.url}`)) {
    score += 6;
  }

  if (new URL(result.url).pathname === '/') {
    score += 2;
  }

  return score;
};

const resolveBusinessWebsite = async (
  lead: Lead,
  request: SearchRequest,
  location: NormalizedUsLocation,
  deadlineMs: number,
  providerHealth: Map<string, ContactProviderHealth>,
) => {
  const queries = buildQueries(lead, request, location);
  const candidates = new Map<string, { result: PublicSearchResult; score: number }>();

  for (const [queryIndex, query] of queries.entries()) {
    if (Date.now() >= deadlineMs) {
      break;
    }

    const availableSources = searchSources.filter(
      (source) => !providerHealth.get(source.name)?.disabled,
    );

    if (!availableSources.length) {
      break;
    }

    const remainingTimeMs = deadlineMs - Date.now();
    if (remainingTimeMs <= 0) {
      break;
    }

    const requestTimeoutMs = Math.min(searchTimeoutMs, remainingTimeMs);

    const rotatedSources = availableSources.map(
      (_, index) => availableSources[(index + queryIndex) % availableSources.length]!,
    );
    const selectedSources = rotatedSources.slice(0, Math.min(2, rotatedSources.length));
    const results = await Promise.all(
      selectedSources.map((source) =>
        searchPublicWebsiteSource(source, query, providerHealth, requestTimeoutMs),
      ),
    );

    for (const sourceResults of results) {
      for (const result of sourceResults) {
        const website = isCandidateWebsite(result.url);

        if (!website || candidates.has(website)) {
          continue;
        }

        candidates.set(website, {
          result: { ...result, url: website },
          score: scoreResult({ ...result, url: website }, lead, request, location),
        });
      }
    }

    if ([...candidates.values()].some((candidate) => candidate.score >= 42)) {
      break;
    }
  }

  const best = [...candidates.values()].sort((left, right) => right.score - left.score)[0];
  const rankedCandidates = [...candidates.values()]
    .filter((candidate) => candidate.score >= 42)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxWebsiteCandidates);

  return {
    website: best && best.score >= 42 ? best.result.url : '',
    candidates: rankedCandidates.map(({ result }) => ({
      website: result.url,
      snippet: result.snippet,
    })),
  };
};

const escapeHtmlText = (value: string) =>
  value.replace(/[&<>]/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    return '&gt;';
  });

const enrichLeadFromPublicSnippet = (lead: Lead, snippet: string) => {
  if (!snippet.trim()) {
    return lead;
  }

  const details = extractContactDetailsFromHtml(
    `<p>${escapeHtmlText(snippet)}</p>`,
  );
  const recoveredContact = Boolean(
    details.emails.length || details.phones.length || details.addresses.length,
  );

  return enrichLead({
    ...lead,
    email: lead.email || details.emails[0] || '',
    mobile: lead.mobile || details.phones[0] || '',
    address: lead.address || details.addresses[0] || '',
    rejectionReason:
      recoveredContact && lead.rejectionReason === 'blocked_website'
        ? undefined
        : lead.rejectionReason,
  });
};

const enrichOneLead = async (
  lead: Lead,
  request: SearchRequest,
  location: NormalizedUsLocation,
  deadlineMs: number,
  providerHealth: Map<string, ContactProviderHealth>,
) => {
  const warnings: ProviderWarning[] = [];
  let enrichedLead = enrichLead(lead);
  let website = enrichedLead.website?.trim() ?? '';

  if (!website && Date.now() < deadlineMs) {
    const resolved = await resolveBusinessWebsite(
      lead,
      request,
      location,
      deadlineMs,
      providerHealth,
    );
    website = resolved.website;

    if (website) {
      const publicWebLead = enrichLead({
        ...enrichedLead,
        website,
        source: addSourceTag(enrichedLead.source, 'Public Web'),
      });
      let bestAttempt = publicWebLead;
      let bestAttemptScore = Number(publicWebLead.hasWebsite);

      for (const candidate of resolved.candidates) {
        if (Date.now() >= deadlineMs) {
          break;
        }

        let candidateLead = enrichLead({
          ...publicWebLead,
          website: candidate.website,
        });

        const crawled = await enrichLeadFromWebsite(candidateLead);
        warnings.push(...crawled.warnings);
        candidateLead = enrichLeadFromPublicSnippet(crawled.lead, candidate.snippet);

        const contactScore =
          Number(candidateLead.hasEmail) * 3 +
          Number(candidateLead.hasPhone) * 3 +
          Number(candidateLead.hasWebsite);

        if (contactScore > bestAttemptScore) {
          bestAttempt = candidateLead;
          bestAttemptScore = contactScore;
        }

        if (candidateLead.hasEmail && candidateLead.hasPhone) {
          break;
        }
      }

      enrichedLead = bestAttempt;
    }
  } else if (website && Date.now() < deadlineMs) {
    const crawled = await enrichLeadFromWebsite({
      ...enrichedLead,
      website,
    });
    warnings.push(...crawled.warnings);
    enrichedLead = enrichLead(crawled.lead);
  }

  return { lead: enrichedLead, warnings };
};

const appendUniqueWarnings = (warnings: ProviderWarning[], incoming: ProviderWarning[]) => {
  for (const warning of incoming) {
    if (
      !warnings.some(
        (existing) =>
          existing.providerId === warning.providerId && existing.message === warning.message,
      )
    ) {
      warnings.push(warning);
    }
  }
};

const preserveLeadAfterEnrichmentFailure = (lead: Lead) => {
  try {
    return enrichLead(lead);
  } catch {
    return lead;
  }
};

const runWithConcurrency = async <T>(
  items: T[],
  requestedConcurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) => {
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(requestedConcurrency)),
  );
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index], index);
      }
    }),
  );
};

export const enrichLinkedinLeadsWithPublicContacts = async ({
  leads,
  request,
  location,
  deadlineMs,
  onProgress,
}: {
  leads: Lead[];
  request: SearchRequest;
  location: NormalizedUsLocation;
  deadlineMs: number;
  onProgress?: (completed: number) => void;
}): Promise<PublicContactEnrichmentResult> => {
  const enriched = [...leads];
  const warnings: ProviderWarning[] = [];
  const providerHealth = createContactProviderHealth();
  let completed = 0;

  await runWithConcurrency(
    leads,
    Math.min(10, concurrency),
    async (lead, index) => {
      if (Date.now() >= deadlineMs) {
        enriched[index] = preserveLeadAfterEnrichmentFailure(lead);
        completed += 1;
        onProgress?.(completed);
        return;
      }

      try {
        const result = await enrichOneLead(
          lead,
          request,
          location,
          deadlineMs,
          providerHealth,
        );
        enriched[index] = result.lead;
        appendUniqueWarnings(warnings, result.warnings);
      } catch {
        // One malformed public page must not discard the rest of the batch.
        enriched[index] = preserveLeadAfterEnrichmentFailure(lead);
        appendUniqueWarnings(warnings, [
          buildWarning(
            providerName,
            'A public contact lookup failed for one profile; its original fields were preserved.',
          ),
        ]);
      } finally {
        completed += 1;
        onProgress?.(completed);
      }
    },
  );

  return {
    leads: enriched,
    warnings: [...buildProviderHealthWarnings(providerHealth), ...warnings],
    enrichedCount: completed,
  };
};
