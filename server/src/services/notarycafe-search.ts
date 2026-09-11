import { createHash } from 'node:crypto';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';
import type { NormalizedUsLocation } from './us-location';
import { buildDiscoverySeeds } from './discovery-seeds';
import { normalizeContactPhone } from './contact-evidence';
import { readResponseTextBounded } from '../utils/bounded-fetch';
import { isNotaryCafeHost, isPublicHttpUrl } from '../utils/public-url';
import { usStateCodes, usStateNames, type UsStateCode } from '../data/us-states';
import { getPublicLeadSourceOrder, getPublicLeadSourcePriority } from '../../../shared/source-priority';

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
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
  disabled: boolean;
  lastMessage: string;
};

export type NotaryCafeDiscoveryResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  coverage: {
    queriesAttempted: number;
    providersChecked: number;
    acceptedCandidates: number;
  };
};

const providerId = 'notarycafe-indexed-search';
const providerName = 'NotaryCafe, Indexed Public Search';
const publicSearchPageSize = 10;
const sourceFailureThreshold = 2;

/**
 * The product's notary ordering is deliberately explicit:
 *
 * 1. NotaryCafe indexed evidence
 * 2. Pure public LinkedIn evidence
 * 3. Yelp public directory
 * 4. Yellow Pages public directory
 * 5. Gemini lead finding and bounded public fallbacks
 * 6. Google Places
 * 7. LinkedIn + Google Business fusion
 *
 * This is an ordering preference, not a relaxation of the public-phone,
 * location, or evidence gates.
 */
export const isNotaryCafeLead = (lead: Lead) => {
  return getPublicLeadSourcePriority(lead) === 1;
};

export const getNotaryCafeEvidencePriority = (lead: Lead) => {
  return getPublicLeadSourceOrder(lead);
};

export const isNotaryCafeCategory = (value: unknown) =>
  typeof value === 'string' &&
  /\bnotar(?:y|ies)\b|\b(?:mobile|loan|signing|remote online|apostille)\s+notar(?:y|ies)\b|\bsigning\s+agent\b/i.test(
    value.trim(),
  );

export const prioritizeNotaryCafeLeads = (
  leads: Lead[],
  requestOrCompanyType: Pick<SearchRequest, 'companyType'> | string,
) => {
  const companyType = typeof requestOrCompanyType === 'string'
    ? requestOrCompanyType
    : requestOrCompanyType.companyType;

  const safeLeads = Array.isArray(leads) ? leads : [];
  if (!isNotaryCafeCategory(companyType)) return [...safeLeads];

  return safeLeads
    .map((lead, index) => ({
      lead,
      index,
      priority: getNotaryCafeEvidencePriority(lead),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ lead }) => lead);
};

/**
 * Apply the complete AI display sequence, regardless of category:
 * NotaryCafe indexed evidence, pure LinkedIn, Yelp, Yellow Pages, Gemini lead
 * finding, Google Places, then LinkedIn plus Google Business fusion. OSM,
 * public websites, and other bounded public fallbacks share the Gemini slot.
 * The caller is responsible for eligibility.
 */
export const prioritizeAiLeadSources = (leads: Lead[]) => {
  const safeLeads = Array.isArray(leads) ? leads : [];

  return safeLeads
    .map((lead, index) => ({
      lead,
      index,
      priority: getNotaryCafeEvidencePriority(lead),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ lead }) => lead);
};

export const prioritizeLeadsForRequest = (leads: Lead[], request: SearchRequest) => {
  const sourceMode: string | undefined = (request as unknown as { sourceMode?: string }).sourceMode;
  if (sourceMode === 'ai' || sourceMode === 'linkedin') {
    return prioritizeAiLeadSources(leads);
  }

  return prioritizeNotaryCafeLeads(leads, request);
};

const reservedProfileSlugs = new Set([
  'about-us',
  'contact-us',
  'find-a-notary',
  'forum',
  'forums',
  'login',
  'plan-and-pricing',
  'register',
  'search',
  'terms',
]);

const readBoundedNumber = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => {
  const parsed = value?.trim() ? Number(value) : Number.NaN;

  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
};

const maxSearchBodyBytes = readBoundedNumber(
  process.env.NOTARYCAFE_INDEX_MAX_BODY_BYTES,
  1_000_000,
  64_000,
  2_000_000,
);

const maxQueries = readBoundedNumber(
  process.env.NOTARYCAFE_INDEX_MAX_QUERIES,
  12,
  1,
  24,
);
const searchTimeoutMs = readBoundedNumber(
  process.env.NOTARYCAFE_INDEX_TIMEOUT_MS,
  4_500,
  500,
  15_000,
);
const maxResults = readBoundedNumber(
  process.env.NOTARYCAFE_INDEX_MAX_RESULTS,
  300,
  1,
  600,
);

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

const blockedBodyPatterns = [
  /(?:captcha|human verification) required/i,
  /too many requests/i,
  /unusual traffic/i,
  /verify.*not a bot/i,
  /access denied/i,
  /(?:cf-chl|just a moment|checking your browser|enable javascript)/i,
  /(?:robot check|prove you are human|rate limit(?:ed)?)/i,
  /temporarily unavailable/i,
];

const normalizeText = (value?: string | null) =>
  (value ?? '').replace(/\s+/g, ' ').trim();

const normalizeCityForComparison = (value?: string) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/\b(?:city|town|village|metro|area)\b/g, ' ')
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
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => decodeCodePoint(hex, 16))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => decodeCodePoint(decimal, 10));

const stripMarkup = (value: string) =>
  decodeHtmlEntities(
    value
      .replace(/!\[[^\]]*\]\((?:[^)]+)\)/g, ' ')
      .replace(/\[([^\]]*?)\]\((https?:\/\/[^)]+)\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .trim(),
  );

const decodeBingUrl = (value: string) => {
  try {
    const url = value.startsWith('//') ? new URL(`https:${value}`) : new URL(value);
    const encoded = url.searchParams.get('u');
    if (!encoded) return value;

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
    return decode(value);
  }
};

const normalizeNotaryCafeProfileUrl = (value?: string) => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (
      url.username ||
      url.password ||
      !isPublicHttpUrl(url) ||
      !isNotaryCafeHost(url) ||
      hostname !== 'notarycafe.com'
    ) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return null;

    const slug = segments[0] ?? '';
    if (
      reservedProfileSlugs.has(slug.toLowerCase()) ||
      !/^[\p{L}\p{N}][\p{L}\p{N}._-]{1,119}$/u.test(slug)
    ) {
      return null;
    }

    return `https://notarycafe.com/${slug}`;
  } catch {
    return null;
  }
};

const parseMarkdownResults = (markdown: string, decodeUrl: (value: string) => string) => {
  const results: SearchResult[] = [];
  const state: { current: SearchResult | null } = { current: null };

  const flush = () => {
    const current = state.current;
    if (current) {
      results.push({ ...current, title: normalizeText(current.title), snippet: normalizeText(current.snippet) });
    }
    state.current = null;
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(?:Title:|URL Source:|Markdown Content:|About this page|Only showing results)/i.test(line)) {
      const active = state.current;
      if (active && !line) active.snippet += ' ';
      continue;
    }

    const linkedProfiles = [...line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
      .map((match) => ({
        title: stripMarkup(match[1] ?? ''),
        url: normalizeNotaryCafeProfileUrl(decodeUrl(match[2] ?? '')),
      }))
      .filter((entry): entry is { title: string; url: string } => Boolean(entry.url));

    if (linkedProfiles.length) {
      flush();
      linkedProfiles.forEach((profile, index) => {
        const next = { title: profile.title || stripMarkup(line), url: profile.url, snippet: '' };
        if (index === linkedProfiles.length - 1) state.current = next;
        else results.push(next);
      });
      continue;
    }

    const active = state.current;
    if (active) active.snippet = `${active.snippet} ${stripMarkup(line)}`.trim();
  }

  flush();
  return results;
};

const parseBingResults = (html: string, decodeUrl: (value: string) => string) => {
  const results: SearchResult[] = [];
  const blocks = [...html.matchAll(/<li\b[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'][\s\S]*?<\/li>/gi)];

  for (const match of blocks) {
    const block = match[0] ?? '';
    const anchor = block.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    if (!anchor?.[1]) continue;

    const url = normalizeNotaryCafeProfileUrl(decodeUrl(decodeHtmlEntities(anchor[1])));
    if (!url) continue;

    const snippet = block.match(/<div\b[^>]*\bclass=["'][^"']*\bb_caption\b[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]
      ?? block.match(/<div\b[^>]*\bclass=["'][^"']*\bb_caption\b[^"']*["'][\s\S]*?<\/div>/i)?.[0]
      ?? '';

    results.push({ title: stripMarkup(anchor[2] ?? ''), url, snippet: stripMarkup(snippet) });
  }

  return results.length ? results : parseMarkdownResults(html, decodeUrl);
};

const parseDuckDuckGoResults = (html: string, decodeUrl: (value: string) => string) => {
  const results: SearchResult[] = [];
  const anchors = [...html.matchAll(/<a\b[^>]*\bresult__a\b[^>]*>([\s\S]*?)<\/a>/gi)];

  anchors.forEach((match, index) => {
    const anchor = match[0] ?? '';
    const rawUrl = decodeHtmlEntities(anchor.match(/\bhref=["']([^"']+)["']/i)?.[1] ?? '').trim();
    const url = normalizeNotaryCafeProfileUrl(decodeUrl(rawUrl));
    if (!url) return;

    const start = (match.index ?? 0) + match[0].length;
    const end = anchors[index + 1]?.index ?? Math.min(html.length, start + 4_000);
    const tail = html.slice(start, end);
    const snippet = tail.match(/class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1] ?? '';
    results.push({ title: stripMarkup(match[1] ?? ''), url, snippet: stripMarkup(snippet) });
  });

  return results;
};

const parseYahooResults = (html: string, decodeUrl: (value: string) => string) => {
  const results: SearchResult[] = [];
  const anchors = [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];

  anchors.forEach((match, index) => {
    const url = normalizeNotaryCafeProfileUrl(decodeUrl(decodeHtmlEntities(match[1] ?? '').trim()));
    if (!url) return;

    const start = (match.index ?? 0) + match[0].length;
    const end = anchors[index + 1]?.index ?? Math.min(html.length, start + 4_000);
    const tail = html.slice(start, end);
    const snippet = tail.match(/<(?:p|div)\b[^>]*\bclass=["'][^"']*(?:compText|aAbs|snippet|description)[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|div)>/i)?.[1] ?? '';
    results.push({ title: stripMarkup(match[2] ?? ''), url, snippet: stripMarkup(snippet || tail) });
  });

  return results;
};

const fetchTextWithTimeout = async (url: string, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/plain, text/markdown, text/html;q=0.9, */*;q=0.8' },
    });
    const body = await readResponseTextBounded(response, maxSearchBodyBytes);
    if (!response.ok) throw new Error(`Search request failed with status ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
};

const isBlockedSearchBody = (body: string) => blockedBodyPatterns.some((pattern) => pattern.test(body));

const parseSearchResults = (source: SearchSource, body: string) => {
  const parsed = source.kind === 'duckduckgo-html'
    ? parseDuckDuckGoResults(body, source.decodeUrl)
    : source.kind === 'yahoo-html'
      ? parseYahooResults(body, source.decodeUrl)
      : source.kind === 'bing-html'
        ? parseBingResults(body, source.decodeUrl)
        : parseMarkdownResults(body, source.decodeUrl);

  return parsed
    .map((result) => ({ ...result, url: normalizeNotaryCafeProfileUrl(result.url) }))
    .filter((result): result is SearchResult & { url: string } => Boolean(result.url));
};

const searchProvider = async (source: SearchSource, query: string, timeoutMs: number): Promise<ProviderSearchResult> => {
  try {
    const body = await fetchTextWithTimeout(source.buildUrl(query), timeoutMs);
    if (isBlockedSearchBody(body)) {
      return { results: [], failure: 'blocked', message: `${source.label} returned a blocked or rate-limited page.` };
    }
    return { results: parseSearchResults(source, body) };
  } catch (error) {
    return {
      results: [],
      failure: 'fetch',
      message: error instanceof Error ? `${source.label} request failed: ${error.message}` : `${source.label} request failed.`,
    };
  }
};

const unique = (values: string[]) => {
  const seen = new Set<string>();
  return values.map(normalizeText).filter((value) => {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const locationTermsFor = (location: NormalizedUsLocation) => {
  if (location.mode === 'local') {
    return unique([location.label, location.city, location.postalCode ?? '']).slice(0, 3);
  }

  return unique(buildDiscoverySeeds(location)).slice(0, location.mode === 'timezone' ? 10 : 14);
};

export const buildNotaryCafeSearchQueries = (
  location: NormalizedUsLocation,
  requestedCount = 50,
  companyType = 'Notary Public',
) => {
  const locationTerms = locationTermsFor(location);
  const categoryPhrase = normalizeText(companyType).replace(/["\r\n]+/g, ' ').trim() || 'Notary Public';
  const isNotaryRequest = isNotaryCafeCategory(categoryPhrase);
  const serviceTerms = unique([
    'notary',
    'mobile notary',
    'notary signing agent',
    'loan signing agent',
    'remote online notary',
    'apostille notary',
  ]);
  const queries: string[] = [];

  // Keep the first pass location-specific, then add looser public-index
  // variants. Search engines differ in how strictly they interpret `site:`
  // and quoted snippets; bounded fallbacks improve recall without increasing
  // direct-origin traffic to NotaryCafe.
  if (isNotaryRequest) {
    for (const place of locationTerms) {
      queries.push(
        `site:notarycafe.com "notary" "${place}" "Phone" -forum -contact -register`,
        `site:notarycafe.com notary "${place}" phone -forum -contact -register`,
        `site:notarycafe.com "Phone Numbers" ${place} notary -forum -contact -register`,
      );
    }

    for (const service of serviceTerms) {
      for (const place of locationTerms) {
        queries.push(
          `site:notarycafe.com "${service}" "${place}" phone -forum -contact -register`,
        );
      }
    }

    if (requestedCount >= 100) {
      queries.push(
        ...locationTerms.map(
          (place) => `site:notarycafe.com/ "Phone Numbers" "${place}" notary -forum -contact`,
        ),
      );
    }
  } else {
    // The adapter is connected to every AI search, but NotaryCafe is a
    // notary directory. Category-aware probes make that connection visible
    // without ever re-labelling an unrelated notary as an HVAC, dental, or
    // other-category lead.
    for (const place of locationTerms.slice(0, 4)) {
      queries.push(
        `site:notarycafe.com "${categoryPhrase}" "${place}" "Phone" -forum -contact -register`,
        `site:notarycafe.com "${place}" "${categoryPhrase}" phone -forum -contact -register`,
      );
    }
  }

  return unique(queries).slice(0, maxQueries);
};

const profileNameFromTitle = (title: string) => {
  const cleaned = normalizeText(stripMarkup(title))
    .replace(/^notary\s*caf[eé]\s*\|\s*/i, '')
    .replace(/\s*(?:\||-)\s*(?:notary\s*caf[eé]|professional profile|profile).*$/i, '')
    .replace(/\s+profile\s*$/i, '')
    .trim();

  if (!cleaned || /^notary\s*caf[eé]$/i.test(cleaned)) return '';
  return cleaned.slice(0, 160);
};

const phonePattern = /(?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\b\d{3})[\s.-]*\d{3}[\s.-]*\d{4}(?:\s*(?:ext(?:ension)?|x)\s*\d{1,6})?/g;
const emailPattern = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/gi;

const extractPhone = (value: string) =>
  [...value.matchAll(phonePattern)]
    .map((match) => normalizeContactPhone(match[0]))
    .find(Boolean) ?? '';

const extractEmail = (value: string) => value.match(emailPattern)?.[0]?.trim().toLowerCase() ?? '';
const extractZip = (value: string) => value.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] ?? '';

const stateNameEntries = (Object.entries(usStateNames) as Array<[UsStateCode, string]>)
  .sort((left, right) => right[1].length - left[1].length);
const stateCodeAlternation = usStateCodes.join('|');
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extractStateCode = (value: string): UsStateCode | undefined => {
  // Do not treat ordinary words such as "in", "or", or "me" as state
  // abbreviations. Only accept an abbreviation in an explicit state label,
  // a city/state pair, or a postal-code pattern.
  const labeledCode = value.match(
    new RegExp(`\\bstate(?:\\s+code)?\\s*[:\\-]?\\s*(${stateCodeAlternation})\\b`, 'i'),
  );
  if (labeledCode?.[1]) return labeledCode[1].toUpperCase() as UsStateCode;

  const cityStateCode = value.match(
    new RegExp(`\\b[A-Za-z][A-Za-z.'-]*(?:\\s+[A-Za-z][A-Za-z.'-]*){0,4}\\s*,\\s*(${stateCodeAlternation})\\b`, 'i'),
  );
  if (cityStateCode?.[1]) return cityStateCode[1].toUpperCase() as UsStateCode;

  const postalStateCode = value.match(
    new RegExp(`\\b(${stateCodeAlternation})\\s+\\d{5}(?:-\\d{4})?\\b`, 'i'),
  );
  if (postalStateCode?.[1]) return postalStateCode[1].toUpperCase() as UsStateCode;

  const lowered = value.toLowerCase();
  return stateNameEntries.find(([, name]) => new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(lowered))?.[0];
};

const extractCity = (value: string, stateCode?: UsStateCode) => {
  const labeled = value.match(/\bcity\s*:\s*([A-Za-z][A-Za-z .'-]{1,60}?)(?=\s+(?:state|zip|phone|email|website)\s*:|\s*$)/i)?.[1];
  if (labeled) return normalizeText(labeled).replace(/[,.]$/, '');

  if (stateCode) {
    const stateNames = [stateCode, usStateNames[stateCode]]
      .filter(Boolean)
      .map(escapeRegExp)
      .join('|');
    const cityBeforeState = value.match(new RegExp(`\\b([A-Za-z][A-Za-z.'-]*(?:\\s+[A-Za-z][A-Za-z.'-]*){0,4})\\s*,\\s*(?:${stateNames})\\b`, 'i'));
    if (cityBeforeState?.[1]) return normalizeText(cityBeforeState[1]);
  }

  return '';
};

const extractOrganizationName = (value: string, personName: string) => {
  const labeled = value.match(
    /\b(?:company|business|organization|firm|agency)\s*(?:name)?\s*:\s*(.+?)(?=\s+(?:name|city|state|zip|phone|mobile|email|website)\s*:|\s*$)/i,
  )?.[1];
  const organization = normalizeText(labeled)
    .replace(/^[|•·,;:-]+|[|•·,;:-]+$/g, '')
    .trim();

  if (
    !organization ||
    organization.length < 3 ||
    organization.length > 180 ||
    organization.toLowerCase() === personName.toLowerCase() ||
    /^(?:notary cafe|profile|public search results?)$/i.test(organization)
  ) {
    return '';
  }

  return organization;
};

const normalizeExternalWebsite = (value: string) => {
  const candidate = value.replace(/[),.;:!?]+$/, '');
  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (
      !isPublicHttpUrl(url) ||
      isNotaryCafeHost(url) ||
      /(?:bing|brave|duckduckgo|google|linkedin|search\.yahoo|facebook|instagram|youtube|x)\.com$/i.test(hostname)
    ) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
};

const extractExternalWebsite = (value: string) => {
  const matches = value.match(/(?:(?:https?:\/\/|www\.)[^\s<>")\]]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>")\]]*)?)/gi) ?? [];
  return matches.map(normalizeExternalWebsite).find(Boolean) ?? '';
};

const createLeadId = (profileUrl: string) =>
  `notarycafe-${createHash('sha1').update(profileUrl).digest('hex').slice(0, 20)}`;

const toLead = (
  result: SearchResult & { url: string },
  request: SearchRequest,
  location: NormalizedUsLocation,
  observedAt: string,
): Lead | undefined => {
  const profileUrl = normalizeNotaryCafeProfileUrl(result.url);
  if (!profileUrl) return undefined;

  // Keep the universal cross-source connection safe: NotaryCafe profiles are
  // only eligible for notary searches. Non-notary probes may still run for
  // coverage visibility, but they can never become misclassified leads.
  if (!isNotaryCafeCategory(request.companyType)) return undefined;

  const snippetText = normalizeText(result.snippet);
  const searchable = normalizeText(`${result.title} ${snippetText}`);
  const phone = extractPhone(searchable);
  const name = profileNameFromTitle(result.title);
  if (!phone || !name) return undefined;

  // Titles commonly contain the person's name and the word "Notary". Read
  // location evidence from the snippet first so title text cannot be
  // mistaken for a multi-word city (for example, "Houston Notary Houston").
  const observedStateCode = extractStateCode(snippetText) || extractStateCode(searchable);
  const requestedStateCode = usStateCodes.find(
    (code) => code === location.stateCode.trim().toUpperCase(),
  );
  if (
    location.mode === 'local' &&
    requestedStateCode &&
    observedStateCode &&
    observedStateCode !== requestedStateCode
  ) {
    return undefined;
  }

  const stateCode = requestedStateCode || observedStateCode;
  if (location.mode === 'timezone' && !stateCode) return undefined;

  const observedCity = extractCity(snippetText, stateCode);
  const zip = extractZip(searchable);
  if (location.mode === 'local' && !observedCity && !zip) {
    return undefined;
  }
  if (
    location.mode === 'local' &&
    observedCity &&
    location.city &&
    normalizeCityForComparison(observedCity) !== normalizeCityForComparison(location.city)
  ) {
    return undefined;
  }
  const city = location.mode === 'local'
    ? observedCity || location.city || location.label
    : extractCity(searchable, stateCode) || (stateCode ? usStateNames[stateCode] : 'United States');
  const website = extractExternalWebsite(searchable);
  const email = extractEmail(searchable);
  const claim = `Public search-index evidence exposed ${name}'s NotaryCafe profile and a phone number. The profile page was not fetched by this worker.`;

  return {
    id: createLeadId(profileUrl),
    name,
    organizationName: extractOrganizationName(searchable, name) || name,
    decisionMakerName: name,
    decisionMakerSourceUrl: profileUrl,
    decisionMaker: true,
    employmentStatus: 'unverified',
    mobile: phone,
    email,
    website,
    contactSourceUrl: profileUrl,
    contactEvidence: [
      {
        field: 'phone',
        value: phone,
        sourceUrl: profileUrl,
        sourceName: providerName,
        sourceKind: 'public_snippet',
        observedAt,
        association: 'business',
      },
      ...(email
        ? [{
            field: 'email' as const,
            value: email,
            sourceUrl: profileUrl,
            sourceName: providerName,
            sourceKind: 'public_snippet' as const,
            observedAt,
            association: 'business' as const,
          }]
        : []),
    ],
    publicEvidence: {
      profileTitle: normalizeText(result.title).slice(0, 240),
      profileSnippet: normalizeText(result.snippet).slice(0, 600),
      sources: [{
        providerName,
        profileTitle: normalizeText(result.title).slice(0, 240),
        profileSnippet: normalizeText(result.snippet).slice(0, 600),
      }],
    },
    evidence: [
      {
        sourceUrl: profileUrl,
        sourceName: providerName,
        claim,
        status: 'unknown',
        observedAt,
      },
    ],
    address: zip ? `${city}${stateCode ? `, ${stateCode}` : ''} ${zip}` : `${city}${stateCode ? `, ${stateCode}` : ''}`,
    state: stateCode ? usStateNames[stateCode] : undefined,
    stateCode,
    postalCode: zip,
    zip,
    category: request.companyType || 'Notary Public',
    city,
    source: providerName,
    confidence: 72,
    sourceScore: 72,
    listingUrl: profileUrl,
    hasEmail: Boolean(email),
    hasPhone: Boolean(phone),
    hasWebsite: Boolean(website),
    verifiedPhone: Boolean(phone),
    verifiedEmail: Boolean(email),
    scrapedAt: observedAt,
  };
};

const createProviderHealth = () =>
  new Map<string, ProviderHealth>(
    searchSources.map((source) => [source.name, { attempts: 0, failures: 0, disabled: false, lastMessage: '' }]),
  );

export const discoverUsLeadsFromNotaryCafeIndex = async ({
  request,
  location,
  deadlineMs = Date.now() + 28_000,
}: {
  request: SearchRequest;
  location: NormalizedUsLocation;
  deadlineMs?: number;
}): Promise<NotaryCafeDiscoveryResult> => {
  const isNotaryRequest = isNotaryCafeCategory(request.companyType);
  const queries = buildNotaryCafeSearchQueries(location, request.count, request.companyType);
  const health = createProviderHealth();
  const resultsByUrl = new Map<string, SearchResult & { url: string }>();
  const warnings: ProviderWarning[] = [];
  let queriesAttempted = 0;

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    if (Date.now() >= deadlineMs || resultsByUrl.size >= maxResults) break;

    const available = searchSources.filter((source) => !health.get(source.name)?.disabled);
    if (!available.length) break;

    const selected = available
      .map((_, index) => available[(index + queryIndex) % available.length]!)
      .slice(0, queryIndex < 2 ? 4 : 2);
    queriesAttempted += 1;
    const remainingMs = Math.max(1, deadlineMs - Date.now());
    const outcomes = await Promise.all(
      selected.map(async (source) => ({
        source,
        outcome: await searchProvider(source, queries[queryIndex]!, Math.min(searchTimeoutMs, remainingMs)),
      })),
    );

    for (const { source, outcome } of outcomes) {
      const sourceHealth = health.get(source.name);
      if (sourceHealth) {
        sourceHealth.attempts += 1;
        if (outcome.failure) {
          sourceHealth.failures += 1;
          sourceHealth.lastMessage = outcome.message ?? `${source.label} search failed.`;
          sourceHealth.disabled = sourceHealth.failures >= sourceFailureThreshold;
        }
      }

      for (const result of outcome.results) {
        const previous = resultsByUrl.get(result.url);
        if (!previous) {
          resultsByUrl.set(result.url, result);
          continue;
        }

        // The same profile can be indexed with different snippets across
        // queries. Merge them so a phone visible in a later result is not lost
        // because the first result only contained the profile title.
        resultsByUrl.set(result.url, {
          ...previous,
          title: previous.title.length >= result.title.length ? previous.title : result.title,
          snippet: [...new Set([previous.snippet, result.snippet].map(normalizeText).filter(Boolean))]
            .join(' ')
            .slice(0, 2_000),
        });
      }
    }
  }

  for (const source of searchSources) {
    const sourceHealth = health.get(source.name);
    if (sourceHealth?.failures) {
      warnings.push({
        providerId: `${providerId}-${source.name}`,
        providerName: source.label,
        message: `${source.label} was unavailable for part of the indexed NotaryCafe search (${sourceHealth.failures}/${sourceHealth.attempts} attempts).`,
        severity: 'info',
      });
    }
  }

  const observedAt = new Date().toISOString();
  const leads = [...resultsByUrl.values()]
    .map((result) => toLead(result, request, location, observedAt))
    .filter((lead): lead is Lead => Boolean(lead));

  if (!isNotaryRequest) {
    warnings.push({
      providerId,
      providerName,
      message: `Indexed NotaryCafe cross-check completed for ${request.companyType}, but NotaryCafe profiles are only eligible for notary-category searches; unrelated profiles were not promoted.`,
      severity: 'info',
    });
  } else if (!leads.length && resultsByUrl.size) {
    warnings.push({
      providerId,
      providerName,
      message: 'Indexed NotaryCafe profiles were found, but none exposed a parseable US phone in the public search result. No unverified records were promoted.',
      severity: 'info',
    });
  }

  if (!leads.length && !resultsByUrl.size && [...health.values()].every((source) => source.disabled)) {
    throw new Error('All public search-index providers were blocked or unavailable; NotaryCafe direct access was not attempted.');
  }

  const acceptedLeads = leads.slice(0, Math.min(maxResults, Math.max(request.count * 3, request.count)));

  return {
    leads: acceptedLeads,
    warnings,
    coverage: {
      queriesAttempted,
      providersChecked: [...health.values()].filter((source) => source.attempts > 0).length,
      acceptedCandidates: acceptedLeads.length,
    },
  } satisfies NotaryCafeDiscoveryResult;
};

export const notaryCafeProviderWarning = (): ProviderWarning => ({
  providerId,
  providerName,
  message: 'Uses search-indexed public NotaryCafe profile references only. Direct page fetching, login, CAPTCHA, Cloudflare, and geo-block bypasses are disabled; public phone evidence is still required.',
  severity: 'info',
});
