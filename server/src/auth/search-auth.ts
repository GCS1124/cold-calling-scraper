import { createHash, timingSafeEqual } from 'node:crypto';

import type { RequestLike } from '../http/search-http-contract';

export type SearchAuthContext = {
  ownerId?: string;
  apiKeyId?: string;
};

type SearchAuthErrorCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'AUTH_UNAVAILABLE';

export class SearchAuthorizationError extends Error {
  readonly code: SearchAuthErrorCode;
  readonly status: 401 | 503;
  readonly retryable: boolean;

  constructor(
    code: SearchAuthErrorCode,
    message: string,
    status: 401 | 503,
    retryable = false,
  ) {
    super(message);
    this.name = 'SearchAuthorizationError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const getHeaderValue = (request: RequestLike, name: string) => {
  const headers = request.headers;
  const headerName = headers
    ? Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
    : undefined;
  const value = headerName ? headers?.[headerName] : undefined;
  return Array.isArray(value) ? value[0] : value;
};

const getBearerToken = (request: RequestLike) => {
  const authorization = getHeaderValue(request, 'authorization')?.trim();
  if (!authorization) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim();
  if (!token || token.length > 8192) {
    throw new SearchAuthorizationError(
      'AUTH_INVALID',
      'Invalid bearer token',
      401,
    );
  }

  return token;
};

const getIntegrationApiKey = (request: RequestLike) => {
  const value = getHeaderValue(request, 'x-api-key')?.trim();
  if (!value) return undefined;
  if (value.length > 4096) {
    throw new SearchAuthorizationError(
      'AUTH_INVALID',
      'Invalid integration API key',
      401,
    );
  }
  return value;
};

type IntegrationApiKeyRecord = {
  id: string;
  ownerId: string;
  sha256: string;
};

const apiKeyHashPattern = /^[a-f0-9]{64}$/i;

const parseIntegrationApiKeys = (raw: string): IntegrationApiKeyRecord[] => {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];

    const id = (entry as { id?: unknown }).id;
    const ownerId = (entry as { ownerId?: unknown }).ownerId;
    const sha256 = (entry as { sha256?: unknown }).sha256;
    if (
      typeof id !== 'string' ||
      typeof ownerId !== 'string' ||
      typeof sha256 !== 'string' ||
      !id.trim() ||
      !ownerId.trim() ||
      !apiKeyHashPattern.test(sha256.trim())
    ) {
      return [];
    }

    return [
      {
        id: id.trim().slice(0, 128),
        ownerId: ownerId.trim().slice(0, 256),
        sha256: sha256.trim().toLowerCase(),
      },
    ];
  });
};

const hashIntegrationApiKey = (apiKey: string) =>
  createHash('sha256').update(apiKey, 'utf8').digest('hex');

const matchesHash = (candidate: string, expected: string) => {
  const candidateBuffer = Buffer.from(candidate, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
};

const isTrue = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

const getAuthConfig = () => ({
  required: isTrue(process.env.LEAD_FINDER_AUTH_REQUIRED),
  supabaseUrl: process.env.SUPABASE_URL?.trim().replace(/\/$/, '') ?? '',
  supabaseKey:
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    '',
  integrationApiKeysRaw: process.env.LEAD_FINDER_INTEGRATION_API_KEYS?.trim() ?? '',
});

export const isSearchAuthRequired = () => getAuthConfig().required;

const getUserId = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const id = (payload as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
};

export const authenticateSearchRequest = async (
  request: RequestLike,
): Promise<SearchAuthContext> => {
  const config = getAuthConfig();
  const apiKey = getIntegrationApiKey(request);
  const token = getBearerToken(request);
  const ownerRequired = config.required || request.requireAuthenticatedOwner === true;

  if (apiKey && token) {
    throw new SearchAuthorizationError(
      'AUTH_INVALID',
      'Use either a bearer token or an integration API key, not both.',
      401,
    );
  }

  if (apiKey) {
    if (!config.integrationApiKeysRaw) {
      throw new SearchAuthorizationError(
        'AUTH_UNAVAILABLE',
        'Integration API-key authentication is not configured for this deployment.',
        503,
      );
    }

    const records = parseIntegrationApiKeys(config.integrationApiKeysRaw);
    if (!records.length) {
      throw new SearchAuthorizationError(
        'AUTH_UNAVAILABLE',
        'Integration API-key authentication is misconfigured for this deployment.',
        503,
      );
    }

    const hashed = hashIntegrationApiKey(apiKey);
    const record = records.find((candidate) => matchesHash(hashed, candidate.sha256));
    if (!record) {
      throw new SearchAuthorizationError(
        'AUTH_INVALID',
        'Invalid integration API key.',
        401,
      );
    }

    return { ownerId: record.ownerId, apiKeyId: record.id };
  }

  if (!token) {
    if (ownerRequired) {
      throw new SearchAuthorizationError(
        'AUTH_REQUIRED',
        'Sign in is required to use lead search.',
        401,
      );
    }

    return {};
  }

  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new SearchAuthorizationError(
      'AUTH_UNAVAILABLE',
      'Search authentication is not configured for this deployment.',
      503,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4_000);

  try {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status >= 500) {
        throw new SearchAuthorizationError(
          'AUTH_UNAVAILABLE',
          'The authentication service is temporarily unavailable.',
          503,
          true,
        );
      }

      throw new SearchAuthorizationError(
        'AUTH_INVALID',
        'Your sign-in session is invalid or expired.',
        401,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SearchAuthorizationError(
        'AUTH_UNAVAILABLE',
        'The authentication service returned an invalid response.',
        503,
        true,
      );
    }

    const ownerId = getUserId(payload);
    if (!ownerId) {
      throw new SearchAuthorizationError(
        'AUTH_INVALID',
        'The authentication service returned an invalid user.',
        401,
      );
    }

    return { ownerId };
  } catch (error) {
    if (error instanceof SearchAuthorizationError) {
      throw error;
    }

    throw new SearchAuthorizationError(
      'AUTH_UNAVAILABLE',
      'The authentication service could not be reached.',
      503,
      true,
    );
  } finally {
    clearTimeout(timeoutId);
  }
};

export const isSearchAuthorizationError = (
  error: unknown,
): error is SearchAuthorizationError => error instanceof SearchAuthorizationError;
