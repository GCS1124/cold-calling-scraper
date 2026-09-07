import { createHash } from 'node:crypto';

import type { SearchRequest } from '../types/search';

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export const normalizeIdempotencyKey = (value: unknown) => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return idempotencyKeyPattern.test(normalized) ? normalized : undefined;
};

export const isValidIdempotencyKey = (value: unknown) =>
  typeof value === 'string' && idempotencyKeyPattern.test(value.trim());

export class SearchIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor() {
    super('Idempotency-Key was already used with a different search request.');
    this.name = 'SearchIdempotencyConflictError';
  }
}

const normalizeText = (value: string) => value.trim().replace(/\s+/g, ' ');

const buildFingerprintPayload = (request: SearchRequest) => {
  const sourceFilters = request.filters?.sources
    ?.map((source) => source.trim())
    .filter(Boolean)
    .sort();
  const filters = request.filters
    ? {
        ...(request.filters.hasEmail === undefined
          ? {}
          : { hasEmail: request.filters.hasEmail }),
        ...(request.filters.hasPhone === undefined
          ? {}
          : { hasPhone: request.filters.hasPhone }),
        ...(request.filters.hasWebsite === undefined
          ? {}
          : { hasWebsite: request.filters.hasWebsite }),
        ...(sourceFilters?.length ? { sources: [...new Set(sourceFilters)] } : {}),
      }
    : undefined;

  return {
    companyType: normalizeText(request.companyType),
    sourceMode: request.sourceMode ?? 'gmb',
    researchDepth: request.researchDepth ?? 'verified',
    ...(request.researchBrief?.trim()
      ? { researchBrief: normalizeText(request.researchBrief) }
      : {}),
    city: normalizeText(request.city),
    count: request.count,
    phoneRequired: true,
    ...(filters && Object.keys(filters).length ? { filters } : {}),
  };
};

export const createSearchRequestFingerprint = (request: SearchRequest) =>
  createHash('sha256')
    .update(JSON.stringify(buildFingerprintPayload(request)))
    .digest('hex');
