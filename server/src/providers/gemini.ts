import axios from 'axios';

import type { Lead, ResearchCandidate } from '../types/lead';
import type { SearchRequest } from '../types/search';
import { publicProviderAxiosLimits } from '../utils/provider-http-limits';
import { isPublicHttpUrl } from '../utils/public-url';
import { isLikelyPublicPersonName, normalizePublicPersonName } from '../utils/public-person';

const geminiQueryModel = (process.env.GEMINI_QUERY_MODEL?.trim() || 'gemini-2.5-flash').replace(
  /^models\//,
  '',
);
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiQueryModel)}:generateContent`;
const MAX_QUERY_HINTS = 8;
const MAX_RESEARCH_CANDIDATES = 120;
const MAX_LISTING_SEEDS = 40;
const MAX_GEMINI_KEY_POOL_SIZE = 20;
const MAX_GEMINI_QUERY_CACHE_ENTRIES = 100;

const parsedGeminiTimeoutMs = Number(process.env.GEMINI_QUERY_TIMEOUT_MS ?? 5_500);
const geminiTimeoutMs = Number.isFinite(parsedGeminiTimeoutMs)
  ? Math.min(7_000, Math.max(1_500, Math.round(parsedGeminiTimeoutMs)))
  : 5_500;

// Grounded search needs more time than a plain generation request, but remains
// bounded so public LinkedIn and listing discovery can finish independently.
const parsedLeadDiscoveryTimeoutMs = Number(process.env.GEMINI_LEAD_DISCOVERY_TIMEOUT_MS ?? 18_000);
const geminiLeadDiscoveryTimeoutMs = Number.isFinite(parsedLeadDiscoveryTimeoutMs)
  ? Math.min(20_000, Math.max(5_000, Math.round(parsedLeadDiscoveryTimeoutMs)))
  : 18_000;

const readBoundedNumber = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) => {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.round(parsed)))
    : fallback;
};

const splitGeminiApiKeys = (value: unknown) =>
  typeof value === 'string'
    ? value
        .split(/[\s,;]+/u)
        .map((key) => key.trim().replace(/^['"]|['"]$/gu, ''))
        .filter(Boolean)
    : [];

/**
 * Read the key pool at request time so local development, Vercel, and tests can
 * update environment configuration without putting secrets in source code.
 * The singular variable remains supported for backwards compatibility.
 */
const readGeminiApiKeys = () => {
  const numberedKeys = Array.from({ length: MAX_GEMINI_KEY_POOL_SIZE }, (_, index) =>
    process.env[`GEMINI_API_KEY_${index + 1}`],
  );

  return [...new Set([
    ...splitGeminiApiKeys(process.env.GEMINI_API_KEYS),
    ...numberedKeys.flatMap(splitGeminiApiKeys),
    ...splitGeminiApiKeys(process.env.GEMINI_API_KEY),
  ])].slice(0, MAX_GEMINI_KEY_POOL_SIZE);
};

/** Safe diagnostic count; raw key values are never returned or logged. */
export const getGeminiApiKeyCount = () => readGeminiApiKeys().length;

const getGeminiRequestPolicy = (keyCount = readGeminiApiKeys().length) => ({
  // A short gap prevents three AI branches from arriving as one burst on the
  // free tier while keeping the normal path fast.
  minRequestGapMs: readBoundedNumber('GEMINI_MIN_REQUEST_GAP_MS', 350, 0, 2_000),
  maxRetries: readBoundedNumber('GEMINI_MAX_RETRIES', 1, 0, 2),
  maxRetryWaitMs: readBoundedNumber('GEMINI_MAX_RETRY_WAIT_MS', 3_500, 0, 8_000),
  cooldownMs: readBoundedNumber('GEMINI_RATE_LIMIT_COOLDOWN_MS', 30_000, 0, 120_000),
  fallbackRetryMs: readBoundedNumber('GEMINI_FALLBACK_RETRY_MS', 1_000, 0, 5_000),
  authFailureCooldownMs: readBoundedNumber(
    'GEMINI_AUTH_FAILURE_COOLDOWN_MS',
    300_000,
    10_000,
    3_600_000,
  ),
  transientFailureCooldownMs: readBoundedNumber(
    'GEMINI_TRANSIENT_FAILURE_COOLDOWN_MS',
    2_000,
    0,
    30_000,
  ),
  queryCacheTtlMs: readBoundedNumber('GEMINI_QUERY_CACHE_TTL_MS', 300_000, 0, 900_000),
  keyRotationAttempts: readBoundedNumber(
    'GEMINI_KEY_ROTATION_ATTEMPTS',
    Math.max(1, Math.min(MAX_GEMINI_KEY_POOL_SIZE, keyCount)),
    1,
    MAX_GEMINI_KEY_POOL_SIZE,
  ),
});

type GeminiErrorShape = {
  response?: {
    status?: unknown;
    headers?: {
      get?: (name: string) => unknown;
      [key: string]: unknown;
    };
  };
};

const responseStatus = (error: unknown) => {
  const status = (error as GeminiErrorShape | undefined)?.response?.status;
  return typeof status === 'number' ? status : Number(status);
};

const responseHeader = (error: unknown, name: string) => {
  const headers = (error as GeminiErrorShape | undefined)?.response?.headers;
  if (!headers) return undefined;

  const getterValue = headers.get?.(name);
  if (getterValue !== undefined) return getterValue;

  return headers[name] ?? headers[name.toLowerCase()];
};

const retryAfterMs = (error: unknown) => {
  const value = responseHeader(error, 'retry-after');
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value * 1_000));
  }

  if (typeof value !== 'string' || !value.trim()) return undefined;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

export class GeminiRateLimitError extends Error {
  readonly retryAfterMs?: number;
  readonly status = 429 as const;

  constructor(waitMs?: number) {
    const boundedWait = typeof waitMs === 'number' && Number.isFinite(waitMs)
      ? Math.max(0, Math.round(waitMs))
      : undefined;
    const waitCopy = boundedWait && boundedWait > 0
      ? ` Retry after about ${Math.ceil(boundedWait / 1_000)} seconds.`
      : ' Retry later.';

    super(`Gemini free-tier quota or rate limit is active.${waitCopy}`);
    this.name = 'GeminiRateLimitError';
    this.retryAfterMs = boundedWait;
  }
}

export class GeminiKeyPoolError extends Error {
  readonly attemptedKeys: number;

  constructor(attemptedKeys: number) {
    super(`Gemini key pool exhausted after ${attemptedKeys} key attempt${attemptedKeys === 1 ? '' : 's'}.`);
    this.name = 'GeminiKeyPoolError';
    this.attemptedKeys = attemptedKeys;
  }
}

export const isGeminiRateLimitError = (error: unknown): error is GeminiRateLimitError =>
  error instanceof GeminiRateLimitError || responseStatus(error) === 429;

const isGeminiKeyRotationFailure = (error: unknown) => {
  const status = responseStatus(error);
  return !Number.isFinite(status) ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 425 ||
    status >= 500;
};

type GeminiKeyState = {
  key: string;
  cooldownUntil: number;
  lastUsedAt: number;
};

// Gemini is used by several independent AI branches. Serialize those calls
// process-wide, rotate successful requests across the configured pool, and
// quarantine only the key that returned a 429. This lets healthy keys continue
// while still stopping a quota response from turning into a request burst.
let geminiRequestTail: Promise<void> = Promise.resolve();
let geminiNextRequestAt = 0;
let geminiKeyCursor = 0;
let geminiKeyStates = new Map<string, GeminiKeyState>();

const enqueueGeminiRequest = <T>(task: () => Promise<T>) => {
  const next = geminiRequestTail.then(task, task);
  geminiRequestTail = next.then(() => undefined, () => undefined);
  return next;
};

const waitMs = (delayMs: number) => {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const syncGeminiKeyStates = (keys: string[]) => {
  const nextStates = new Map<string, GeminiKeyState>();
  for (const key of keys) {
    nextStates.set(key, geminiKeyStates.get(key) ?? {
      key,
      cooldownUntil: 0,
      lastUsedAt: 0,
    });
  }

  geminiKeyStates = nextStates;
  if (geminiKeyCursor >= keys.length) geminiKeyCursor = 0;
  return keys.map((key) => nextStates.get(key) as GeminiKeyState);
};

const nextGeminiKeyReadyAt = (keys: string[]) => {
  const states = syncGeminiKeyStates(keys);
  return states.length ? Math.min(...states.map((state) => state.cooldownUntil)) : 0;
};

const hasAvailableGeminiKey = (keys: string[], now = Date.now()) =>
  syncGeminiKeyStates(keys).some((state) => state.cooldownUntil <= now);

const takeNextAvailableGeminiKey = (keys: string[], now = Date.now()) => {
  const states = syncGeminiKeyStates(keys);
  if (!states.length) return undefined;

  for (let offset = 0; offset < states.length; offset += 1) {
    const index = (geminiKeyCursor + offset) % states.length;
    const state = states[index];
    if (state.cooldownUntil > now) continue;

    state.lastUsedAt = now;
    geminiKeyCursor = (index + 1) % states.length;
    return state;
  }

  return undefined;
};

type GeminiQueryCacheEntry = {
  hints: string[];
  expiresAt: number;
};

const geminiQueryCache = new Map<string, GeminiQueryCacheEntry>();

const geminiQueryCacheKey = (rawQuery: string, request: SearchRequest) =>
  JSON.stringify([
    rawQuery.trim().toLowerCase(),
    request.companyType.trim().toLowerCase(),
    request.city.trim().toLowerCase(),
    request.researchBrief?.trim() ?? '',
  ]);

const getCachedGeminiQueryHints = (key: string, ttlMs: number) => {
  if (ttlMs <= 0) return undefined;

  const entry = geminiQueryCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    geminiQueryCache.delete(key);
    return undefined;
  }

  // Refresh insertion order so the bounded map behaves as a small LRU cache.
  geminiQueryCache.delete(key);
  geminiQueryCache.set(key, entry);
  return [...entry.hints];
};

const cacheGeminiQueryHints = (key: string, hints: string[], ttlMs: number) => {
  if (ttlMs <= 0 || !hints.length) return;

  geminiQueryCache.delete(key);
  geminiQueryCache.set(key, {
    hints: [...hints],
    expiresAt: Date.now() + ttlMs,
  });

  while (geminiQueryCache.size > MAX_GEMINI_QUERY_CACHE_ENTRIES) {
    const oldestKey = geminiQueryCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    geminiQueryCache.delete(oldestKey);
  }
};

const waitForRequestWindow = async (
  deadlineAt: number,
  keys: string[],
  requiredKey?: GeminiKeyState,
) => {
  const now = Date.now();
  if (now >= deadlineAt) {
    throw new Error('Gemini request deadline expired before a provider slot was available.');
  }

  const keyReadyAt = requiredKey
    ? requiredKey.cooldownUntil
    : hasAvailableGeminiKey(keys, now)
      ? now
      : nextGeminiKeyReadyAt(keys);
  const delay = Math.max(geminiNextRequestAt, keyReadyAt) - now;
  if (delay <= 0) return;
  if (Date.now() + delay >= deadlineAt) {
    throw new GeminiRateLimitError(Math.max(0, keyReadyAt - Date.now()));
  }
  await waitMs(delay);
};

/** Reset only the in-process gate; exported for deterministic provider tests. */
export const resetGeminiRequestStateForTests = () => {
  geminiRequestTail = Promise.resolve();
  geminiNextRequestAt = 0;
  geminiKeyCursor = 0;
  geminiKeyStates = new Map();
  geminiQueryCache.clear();
};

export const isGeminiRateLimited = () => {
  const keys = readGeminiApiKeys();
  return keys.length > 0 && !hasAvailableGeminiKey(keys);
};

const isExplicitlyDisabled = (name: string) =>
  process.env[name]?.trim().toLowerCase() === 'false';

/** A configured key enables the free/public Gemini layer unless explicitly disabled. */
export const isGeminiQueryAssistanceEnabled = () =>
  getGeminiApiKeyCount() > 0 &&
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
  if (!data || typeof data !== 'object') return '';
  const candidates = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return '';
  const candidate = candidates[0];
  if (!candidate || typeof candidate !== 'object') return '';
  const content = (candidate as { content?: unknown }).content;
  if (!content || typeof content !== 'object') return '';
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return '';

  return parts
    .map((part) => (
      part && typeof part === 'object'
        ? readString((part as { text?: unknown }).text, 20_000)
        : ''
    ))
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
  if (!data || typeof data !== 'object') return [];
  const candidates = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  const candidate = candidates[0];
  if (!candidate || typeof candidate !== 'object') return [];
  const metadata = (candidate as { groundingMetadata?: unknown }).groundingMetadata;
  if (!metadata || typeof metadata !== 'object') return [];
  const groundingChunks = (metadata as { groundingChunks?: unknown }).groundingChunks;
  if (!Array.isArray(groundingChunks)) return [];

  const sources = groundingChunks
    .map((chunk): GroundingSource | undefined => {
      if (!chunk || typeof chunk !== 'object') return undefined;
      const web = (chunk as { web?: unknown }).web;
      if (!web || typeof web !== 'object') return undefined;
      return {
        url: normalizePublicSourceUrl((web as { uri?: unknown }).uri),
        title: readString((web as { title?: unknown }).title, 240),
      };
    })
    .filter((source): source is GroundingSource => Boolean(source?.url));

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

export type GeminiListingSeed = Pick<
  Lead,
  'name' | 'organizationName' | 'address' | 'website' | 'listingUrl' | 'mobile' | 'source'
>;

const serializeListingSeeds = (listingSeeds: GeminiListingSeed[]) => {
  const seeds = listingSeeds
    .map((listing) => ({
      name: readString(listing.name, 180),
      organizationName: readString(listing.organizationName, 220),
      address: readString(listing.address, 240),
      website: normalizePublicSourceUrl(listing.website),
      listingUrl: normalizePublicSourceUrl(listing.listingUrl),
      publicPhone: readString(listing.mobile, 80),
      source: readString(listing.source, 100),
    }))
    .filter((listing) => listing.name || listing.organizationName || listing.listingUrl)
    .slice(0, MAX_LISTING_SEEDS);

  if (!seeds.length) return '';

  return `\nPublic Google Business (GMB) and other business-listing seeds to enrich (these are starting points, not private data):\n${JSON.stringify(seeds)}\nFor each seed you can support, search public pages for the company and its current owner, founder, principal, CEO, operator, practice administrator, or other decision-maker. Return a separate personName for a human and organizationName for the business; never copy the company name into personName. Include the person's public role when shown. Preserve the seed listingUrl in sourceUrls when you discuss that company. Re-check any phone or email against a cited public page; do not guess or infer missing values.`;
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
    const organizationName = readString(item.organizationName ?? item.organization ?? item.company, 220);
    const rawName = readString(item.name, 180);
    const explicitPersonName = normalizePublicPersonName(readString(
      item.personName ?? item.contactName ?? item.ownerName ?? item.founderName ?? item.decisionMakerName,
      180,
    ));
    const personName = explicitPersonName || (
      rawName && organizationName && isLikelyPublicPersonName(rawName) ? rawName : ''
    );
    const name = rawName || personName;
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
      !personName &&
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
      ...(personName ? { personName } : {}),
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
  const apiKeys = readGeminiApiKeys();
  if (!apiKeys.length) {
    throw new Error('GEMINI_API_KEY or GEMINI_API_KEYS is not configured.');
  }

  const policy = getGeminiRequestPolicy(apiKeys.length);
  const deadlineAt = Date.now() + timeout;

  return enqueueGeminiRequest(async () => {
    if (Date.now() >= deadlineAt) {
      throw new Error('Gemini request deadline expired before a provider slot was available.');
    }

    const maxKeyAttempts = Math.max(
      1,
      Math.min(apiKeys.length, policy.keyRotationAttempts),
    );
    const triedKeys = new Set<string>();
    let retryAttempt = 0;
    let forcedRetryKey: GeminiKeyState | undefined;

    while (triedKeys.size < maxKeyAttempts || forcedRetryKey) {
      await waitForRequestWindow(deadlineAt, apiKeys, forcedRetryKey);

      const selectedKey = forcedRetryKey ?? takeNextAvailableGeminiKey(apiKeys);
      forcedRetryKey = undefined;
      if (!selectedKey) {
        throw new GeminiRateLimitError(
          Math.max(0, nextGeminiKeyReadyAt(apiKeys) - Date.now()),
        );
      }

      triedKeys.add(selectedKey.key);
      const remainingMs = Math.max(1, deadlineAt - Date.now());
      if (Date.now() >= deadlineAt) {
        throw new Error('Gemini request deadline expired before a provider slot was available.');
      }
      // Set the next slot before sending so a retry, key rotation, and queued
      // branch cannot immediately create another provider burst.
      geminiNextRequestAt = Date.now() + policy.minRequestGapMs;

      try {
        return await axios.post(GEMINI_ENDPOINT, body, {
          timeout: remainingMs,
          ...publicProviderAxiosLimits,
          headers: {
            // Keep the key out of request URLs, logs, and proxy cache keys.
            'x-goog-api-key': selectedKey.key,
          },
        });
      } catch (error) {
        const status = responseStatus(error);
        if (status !== 429) {
          const canRotate = triedKeys.size < maxKeyAttempts;
          if (!isGeminiKeyRotationFailure(error)) throw error;
          if (!canRotate) throw new GeminiKeyPoolError(triedKeys.size);

          const failureCooldownMs = status === 401 || status === 403
            ? policy.authFailureCooldownMs
            : policy.transientFailureCooldownMs;
          selectedKey.cooldownUntil = Math.max(
            selectedKey.cooldownUntil,
            Date.now() + failureCooldownMs,
          );

          // Invalid/revoked keys and transient provider failures should not
          // block the rest of the configured pool.
          continue;
        }

        const serverRetryMs = retryAfterMs(error);
        const cooldownMs = Math.max(serverRetryMs ?? 0, policy.cooldownMs);
        const requestedWaitMs = serverRetryMs ?? policy.fallbackRetryMs * 2 ** retryAttempt;
        const waitForRetry = Math.min(requestedWaitMs, policy.maxRetryWaitMs);
        const retryHintIsShortEnough = serverRetryMs === undefined ||
          serverRetryMs <= policy.maxRetryWaitMs;
        const canRotate = triedKeys.size < maxKeyAttempts;
        const alternateKeyAvailable = canRotate && apiKeys.some((key) => {
          if (triedKeys.has(key)) return false;
          const state = geminiKeyStates.get(key);
          return !state || state.cooldownUntil <= Date.now();
        });
        const canRetry = !alternateKeyAvailable && retryHintIsShortEnough &&
          retryAttempt < policy.maxRetries &&
          waitForRetry <= Math.max(0, deadlineAt - Date.now() - 1_000);

        if (canRetry) {
          // With no healthy alternate key, honor one short retry on the same
          // key. Long quota windows still fail fast for deterministic sources.
          selectedKey.cooldownUntil = Math.max(
            selectedKey.cooldownUntil,
            Date.now() + waitForRetry,
          );
          forcedRetryKey = selectedKey;
          retryAttempt += 1;
          continue;
        }

        // Quarantine only the exhausted key, then immediately rotate to the
        // next untried key. If every key is exhausted, the caller receives a
        // typed rate-limit result and deterministic discovery takes over.
        selectedKey.cooldownUntil = Math.max(
          selectedKey.cooldownUntil,
          Date.now() + cooldownMs,
        );

        if (!canRotate) {
          throw new GeminiRateLimitError(
            Math.max(0, nextGeminiKeyReadyAt(apiKeys) - Date.now()),
          );
        }
      }
    }

    throw new GeminiRateLimitError(
      Math.max(0, nextGeminiKeyReadyAt(apiKeys) - Date.now()),
    );
  });
};

export const expandQueryWithGemini = async (
  rawQuery: string,
  request: SearchRequest,
): Promise<string[]> => {
  if (!isGeminiQueryAssistanceEnabled()) return [];

  const policy = getGeminiRequestPolicy(getGeminiApiKeyCount());
  const cacheKey = geminiQueryCacheKey(rawQuery, request);
  const cachedHints = getCachedGeminiQueryHints(cacheKey, policy.queryCacheTtlMs);
  if (cachedHints) return cachedHints;

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

  const hints = normalizeGeminiQueryHints(modelText(response.data));
  cacheGeminiQueryHints(cacheKey, hints, policy.queryCacheTtlMs);
  return hints;
};

export const discoverLeadsWithGemini = async (
  request: SearchRequest,
  locationLabel: string,
  listingSeeds: GeminiListingSeed[] = [],
  searchLocationContext = locationLabel,
  timeoutMs = geminiLeadDiscoveryTimeoutMs,
): Promise<GeminiLeadDiscoveryResult> => {
  if (!isGeminiLeadDiscoveryEnabled()) return { candidates: [], groundingSources: [] };

  const listingSeedContext = serializeListingSeeds(listingSeeds);

  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.min(20_000, Math.max(1_000, Math.round(timeoutMs)))
    : geminiLeadDiscoveryTimeoutMs;

  const response = await geminiRequest(
    {
      contents: [
        {
          parts: [
            {
              text: `Use Google Search to find public, current US business lead candidates for this request. Search official company websites, public professional profile pages, trade associations, licensing or registry pages, news, public social links, and reputable business directories. Return JSON only with a candidates array, up to 40 concise records. Each record may include: personName, name, organizationName, role, location, website, profileUrl, phone, email, socialLinks, sourceUrls, sourceTitles, evidence. Use personName only for a human explicitly shown on a cited public page; use organizationName for the business, and never put the company name in personName. Include current owner, founder, principal, CEO, operator, practice administrator, or another clearly labeled decision-maker when publicly evidenced. Include only details visible in public search results or cited pages. Phone and email must be publicly listed business contact details, never guessed or inferred. Do not use private/authenticated profiles, Sales Navigator/Premium, paywalls, contact-reveal services, commercial lead databases, login sessions, or bypasses. Keep former or conflicting roles marked in evidence instead of presenting them as current. Always include sourceUrls for supporting pages; never fabricate a URL.\nCompany type: ${request.companyType}\nTarget location: ${searchLocationContext}\nKeep the canonical response location as ${locationLabel} when a candidate does not state a more precise city or state. For a timezone or nationwide request, search the concrete representative cities and states in the location context rather than searching the timezone label as if it were a city.\nResearch brief: ${request.researchBrief?.trim() || 'Find owner-led businesses and their publicly evidenced decision-makers.'}${listingSeedContext}`,
            },
          ],
        },
      ],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4_000,
      },
    },
    boundedTimeoutMs,
  );

  return parseGroundedGeminiCandidates(response.data);
};
