import { createHmac, randomUUID } from 'node:crypto';

import type { SearchResponse, SearchStatus } from '../types/search';
import type {
  SearchCallbackRequest,
  SearchCallbackStatus,
} from '../../../shared/search-contract';
import { isPublicHttpsCallbackUrl } from '../utils/public-url';
import type { SearchJobRecord, SearchJobStore } from './search-job-store';

const terminalStatuses = new Set<SearchStatus>(['complete', 'failed', 'cancelled']);
const retryableStatusCodes = new Set([408, 425, 429]);
const maxCallbackUrlLength = 2_048;
const callbackTimeoutMs = Math.max(
  1_000,
  Math.min(15_000, Number(process.env.LEAD_FINDER_CALLBACK_TIMEOUT_MS ?? 8_000)),
);

export type SearchCallbackState = {
  url: string;
  eventId: string;
  status: SearchCallbackStatus;
  attempts: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  lastStatusCode?: number;
  deliveredAt?: number;
  lastError?: string;
};

export type SearchCompletionCallbackPayload = {
  event: 'search.completed';
  eventId: string;
  emittedAt: string;
  searchId: string;
  status: SearchStatus;
  response: SearchResponse;
};

export const hasCallbackSigningSecret = () =>
  Boolean(process.env.LEAD_FINDER_INTEGRATION_CALLBACK_SIGNING_SECRET?.trim());

export const normalizeCallbackRequest = (value: unknown): SearchCallbackRequest | undefined => {
  if (!value || typeof value !== 'object') return undefined;

  const url = (value as { url?: unknown }).url;
  if (
    typeof url !== 'string' ||
    url.trim().length === 0 ||
    url.trim().length > maxCallbackUrlLength ||
    !isPublicHttpsCallbackUrl(url.trim())
  ) {
    return undefined;
  }

  return { url: url.trim() };
};

export const sanitizeCallbackState = (value: unknown): SearchCallbackState | undefined => {
  if (!value || typeof value !== 'object') return undefined;

  const raw = value as Partial<SearchCallbackState>;
  const request = normalizeCallbackRequest({ url: raw.url });
  const eventId = typeof raw.eventId === 'string' ? raw.eventId.trim().slice(0, 128) : '';
  const status = raw.status;
  if (!request || !eventId || !['pending', 'retrying', 'delivered', 'failed'].includes(status ?? '')) {
    return undefined;
  }

  const normalizeTimestamp = (timestamp: unknown) =>
    Number.isFinite(timestamp) ? Math.max(0, Math.floor(timestamp as number)) : undefined;
  const normalizeStatusCode = (statusCode: unknown) =>
    Number.isInteger(statusCode) && Number(statusCode) >= 100 && Number(statusCode) <= 599
      ? Number(statusCode)
      : undefined;

  return {
    ...request,
    eventId,
    status: status as SearchCallbackStatus,
    attempts: Math.min(8, Math.max(0, Math.floor(Number(raw.attempts ?? 0)))),
    lastAttemptAt: normalizeTimestamp(raw.lastAttemptAt),
    nextAttemptAt: normalizeTimestamp(raw.nextAttemptAt),
    lastStatusCode: normalizeStatusCode(raw.lastStatusCode),
    deliveredAt: normalizeTimestamp(raw.deliveredAt),
    lastError:
      typeof raw.lastError === 'string' && raw.lastError.trim()
        ? raw.lastError.trim().slice(0, 500)
        : undefined,
  };
};

export const createSearchCallbackState = (url: string, now: number): SearchCallbackState => ({
  url,
  eventId: `evt_${randomUUID()}`,
  status: 'pending',
  attempts: 0,
  nextAttemptAt: now,
});

export const isCallbackDue = (callback: SearchCallbackState | undefined, now: number) =>
  Boolean(
    callback &&
      ['pending', 'retrying'].includes(callback.status) &&
      (callback.nextAttemptAt ?? 0) <= now,
  );

export const isCallbackPending = (callback: SearchCallbackState | undefined) =>
  Boolean(callback && ['pending', 'retrying'].includes(callback.status));

const maxAttempts = () =>
  Math.min(8, Math.max(1, Math.floor(Number(process.env.LEAD_FINDER_CALLBACK_MAX_ATTEMPTS ?? 5))));

const retryDelayMs = (attempt: number) =>
  Math.min(
    15 * 60_000,
    Math.max(1_000, Number(process.env.LEAD_FINDER_CALLBACK_RETRY_BASE_MS ?? 15_000)) *
      2 ** Math.max(0, attempt - 1),
  );

const safeErrorMessage = (error: unknown, callbackUrl: string) => {
  const raw = error instanceof Error ? error.message : 'Callback request failed.';
  return raw.replaceAll(callbackUrl, '[callback endpoint]').slice(0, 500);
};

const appendTerminalWarning = (job: SearchJobRecord, message: string) => {
  if (
    job.providerWarnings.some(
      (warning) => warning.providerId === 'integration-callback' && warning.message === message,
    )
  ) {
    return;
  }

  job.providerWarnings.push({
    providerId: 'integration-callback',
    providerName: 'Integration callback',
    message,
    severity: 'warning',
  });
};

export type CallbackFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const deliverSearchCompletionCallback = async (args: {
  job: SearchJobRecord;
  response: SearchResponse;
  store: SearchJobStore;
  now?: () => number;
  fetchImplementation?: CallbackFetch;
}) => {
  const now = args.now ?? Date.now;
  const callback = args.job.callback;
  const attemptStartedAt = now();

  if (
    !terminalStatuses.has(args.job.status) ||
    !callback ||
    !isCallbackDue(callback, attemptStartedAt)
  ) {
    return args.job;
  }

  const signingSecret = process.env.LEAD_FINDER_INTEGRATION_CALLBACK_SIGNING_SECRET?.trim();
  const attempt = callback.attempts + 1;
  const attemptState: SearchCallbackState = {
    ...callback,
    attempts: attempt,
    lastAttemptAt: attemptStartedAt,
    nextAttemptAt: undefined,
    lastError: undefined,
  };

  if (!signingSecret) {
    attemptState.status = 'failed';
    attemptState.lastError = 'Callback signing secret is not configured.';
    args.job.callback = attemptState;
    appendTerminalWarning(
      args.job,
      'Completion callback was not sent because callback signing is not configured.',
    );
    await args.store.upsert(args.job);
    return args.job;
  }

  const payload: SearchCompletionCallbackPayload = {
    event: 'search.completed',
    eventId: callback.eventId,
    emittedAt: new Date(attemptStartedAt).toISOString(),
    searchId: args.job.searchId,
    status: args.job.status,
    response: args.response,
  };
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(attemptStartedAt / 1_000).toString();
  const signature = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const fetchImplementation = args.fetchImplementation ?? globalThis.fetch;

  let statusCode: number | undefined;
  let failure: string | undefined;

  if (!fetchImplementation) {
    failure = 'Callback fetch is not available in this runtime.';
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), callbackTimeoutMs);

    try {
      const response = await fetchImplementation(callback.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'LeadFinder-Integration/1.0',
          'X-Lead-Finder-Event': payload.event,
          'X-Lead-Finder-Event-Id': callback.eventId,
          'X-Lead-Finder-Search-Id': args.job.searchId,
          'X-Lead-Finder-Timestamp': timestamp,
          'X-Lead-Finder-Signature': `t=${timestamp},v1=${signature}`,
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      statusCode = response.status;
      if (!response.ok) {
        failure = `Callback endpoint returned HTTP ${response.status}.`;
      }
    } catch (error) {
      failure = safeErrorMessage(error, callback.url);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!failure) {
    args.job.callback = {
      ...attemptState,
      status: 'delivered',
      lastStatusCode: statusCode,
      deliveredAt: now(),
    };
  } else {
    const retryable =
      statusCode === undefined ||
      retryableStatusCodes.has(statusCode) ||
      statusCode >= 500;
    const canRetry = retryable && attempt < maxAttempts();
    args.job.callback = {
      ...attemptState,
      status: canRetry ? 'retrying' : 'failed',
      lastStatusCode: statusCode,
      lastError: failure,
      ...(canRetry ? { nextAttemptAt: now() + retryDelayMs(attempt) } : {}),
    };

    if (!canRetry) {
      appendTerminalWarning(
        args.job,
        `Completion callback stopped after ${attempt} attempt(s): ${failure}`,
      );
    }
  }

  await args.store.upsert(args.job);
  return args.job;
};
