import type { RequestLike } from './search-http-contract';
import {
  getRequestId,
  sendSearchError,
  setRequestIdHeader,
} from './search-http-contract';
import { isSearchPersistenceError } from '../services/search-job-store';
import { integrationRateLimiter } from '../services/integration-rate-limit';
import { integrationQuotaEnforcer } from '../services/integration-quota';

export const enforceIntegrationRateLimit = async (
  request: RequestLike,
  response: any,
): Promise<boolean> => {
  const requestId = getRequestId(request);
  setRequestIdHeader(response, requestId);

  try {
    const rate = await integrationRateLimiter.consume(request);
    response.setHeader?.('X-RateLimit-Limit', String(rate.limit));
    response.setHeader?.('X-RateLimit-Remaining', String(rate.remaining));
    response.setHeader?.('X-RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));

    if (!rate.allowed) {
      const retryAfter = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
      response.setHeader?.('Retry-After', String(retryAfter));
      sendSearchError(response, 429, {
        code: 'INTEGRATION_RATE_LIMITED',
        message: 'Integration request rate limit exceeded. Try again later.',
        retryable: true,
        requestId,
      });
      return false;
    }
  } catch (error) {
    if (isSearchPersistenceError(error)) {
      sendSearchError(response, 503, {
        code: error.code,
        message: error.message,
        retryable: true,
        requestId,
      });
      return false;
    }

    sendSearchError(response, 503, {
      code: 'INTEGRATION_RATE_LIMIT_UNAVAILABLE',
      message: 'Integration traffic protection is temporarily unavailable.',
      retryable: true,
      requestId,
    });
    return false;
  }

  request.headers = request.headers ?? {};
  const hasRequestId = Object.keys(request.headers).some(
    (key) => key.toLowerCase() === 'x-request-id',
  );
  if (!hasRequestId) request.headers['x-request-id'] = requestId;
  return true;
};

export const enforceIntegrationQuota = async (
  request: RequestLike,
  response: any,
): Promise<boolean> => {
  const requestId = getRequestId(request);
  setRequestIdHeader(response, requestId);

  try {
    const quota = await integrationQuotaEnforcer.consume(request);
    if (quota.limit > 0) {
      response.setHeader?.('X-Quota-Limit', String(quota.limit));
      response.setHeader?.('X-Quota-Remaining', String(quota.remaining));
      response.setHeader?.('X-Quota-Reset', String(Math.ceil(quota.resetAt / 1000)));
    }

    if (!quota.allowed) {
      const retryAfter = Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 1000));
      response.setHeader?.('Retry-After', String(retryAfter));
      sendSearchError(response, 429, {
        code: 'INTEGRATION_QUOTA_EXCEEDED',
        message: 'Integration daily request quota exceeded. Try again tomorrow.',
        retryable: true,
        requestId,
      });
      return false;
    }
  } catch (error) {
    if (isSearchPersistenceError(error)) {
      sendSearchError(response, 503, {
        code: error.code,
        message: error.message,
        retryable: true,
        requestId,
      });
      return false;
    }

    sendSearchError(response, 503, {
      code: 'INTEGRATION_QUOTA_UNAVAILABLE',
      message: 'Integration quota protection is temporarily unavailable.',
      retryable: true,
      requestId,
    });
    return false;
  }

  return true;
};
