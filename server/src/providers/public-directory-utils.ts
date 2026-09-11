import { createHash } from 'node:crypto';

import { mergeContactEvidence, normalizeContactPhone } from '../services/contact-evidence';
import { isPublicHttpUrl } from '../utils/public-url';
import type { ContactEvidence } from '../../../shared/lead-quality';

export type StructuredDirectoryEntity = {
  name?: string;
  telephone?: string;
  url?: string;
};
// Accept both formatted numbers and the compact 10/11 digit form commonly
// emitted by directory JSON-LD, while keeping digit boundaries strict enough
// to avoid treating IDs and timestamps as phones.
const phonePattern = /(?<!\d)(?:\+?1[\s().-]*)?(?:\(\s*[2-9]\d{2}\s*\)|[2-9]\d{2})[\s.-]*[2-9]\d{2}[\s.-]*\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d+)?(?!\d)/gi;

const normalizeName = (value?: string) =>
  typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';

export const buildProviderSearchUrl = (
  baseUrl: string,
  params: Record<string, string>,
) => {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

export const toPublicAbsoluteUrl = (
  value: string | undefined,
  baseUrl: string,
  blockedHosts: readonly string[] = [],
) => {
  if (!value?.trim()) return '';

  try {
    const url = new URL(value.trim(), baseUrl);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    const isBlockedHost = blockedHosts.some(
      (blockedHost) => hostname === blockedHost || hostname.endsWith(`.${blockedHost}`),
    );

    if (!isPublicHttpUrl(url) || isBlockedHost) return '';
    return url.toString();
  } catch {
    return '';
  }
};

export const toProviderListingUrl = (
  value: string | undefined,
  baseUrl: string,
  pathPattern: RegExp,
  fallbackUrl: string,
  allowedHosts: readonly string[] = [],
) => {
  if (!value?.trim()) return fallbackUrl;

  try {
    const url = new URL(value.trim(), baseUrl);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    const hostAllowed = !allowedHosts.length || allowedHosts.some(
      (allowedHost) => hostname === allowedHost || hostname.endsWith(`.${allowedHost}`),
    );

    if (
      !isPublicHttpUrl(url) ||
      !hostAllowed ||
      !pathPattern.test(url.pathname)
    ) return fallbackUrl;
    return url.toString();
  } catch {
    return fallbackUrl;
  }
};

/** Stable across query order, provider retries, and pagination. */
export const buildStableProviderLeadId = (
  providerId: string,
  identityParts: Array<string | undefined>,
) => {
  const identity = identityParts
    .map((part) => (part ?? '').trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('|') || 'unknown';
  const digest = createHash('sha256')
    .update(`${providerId}|${identity}`)
    .digest('hex')
    .slice(0, 20);

  return `${providerId}-${digest}`;
};

export const extractDirectoryPhone = (...values: Array<string | undefined>) => {
  for (const value of values) {
    if (!value?.trim()) continue;

    const direct = normalizeContactPhone(value.replace(/^tel:/i, '').trim());
    if (direct) return direct;

    for (const match of value.matchAll(phonePattern)) {
      const normalized = normalizeContactPhone(match[0]);
      if (normalized) return normalized;
    }
  }

  return '';
};

export const extractStructuredDirectoryEntities = (scripts: string[]) => {
  const entities: StructuredDirectoryEntity[] = [];

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (!value || typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    if (
      typeof record.name === 'string' ||
      typeof record.telephone === 'string' ||
      typeof record.url === 'string'
    ) {
      entities.push({
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.telephone === 'string' ? { telephone: record.telephone } : {}),
        ...(typeof record.url === 'string' ? { url: record.url } : {}),
      });
    }

    for (const key of ['@graph', 'item', 'itemListElement', 'mainEntity', 'mainEntityOfPage']) {
      if (record[key]) visit(record[key]);
    }
  };

  for (const script of scripts) {
    if (!script.trim()) continue;

    try {
      visit(JSON.parse(script));
    } catch {
      // A malformed or partial JSON-LD block is not evidence; visible card
      // fields remain the only fallback for that record.
    }
  }

  return entities;
};

export const findStructuredDirectoryEntity = (
  entities: StructuredDirectoryEntity[],
  name: string,
) => {
  const normalized = normalizeName(name);
  if (!normalized) return undefined;

  return entities.find((entity) => normalizeName(entity.name) === normalized) ??
    entities.find((entity) => {
      const candidate = normalizeName(entity.name);
      return candidate.length > 3 && (candidate.includes(normalized) || normalized.includes(candidate));
    });
};

export const buildDirectoryPhoneEvidence = ({
  phone,
  sourceUrl,
  sourceName,
  observedAt,
}: {
  phone: string;
  sourceUrl: string;
  sourceName: string;
  observedAt: string;
}): ContactEvidence[] => {
  if (!phone || !sourceUrl) return [];

  return mergeContactEvidence([{
    field: 'phone',
    value: phone,
    sourceUrl,
    sourceName,
    sourceKind: 'business_listing',
    observedAt,
    association: 'business',
  }]);
};
