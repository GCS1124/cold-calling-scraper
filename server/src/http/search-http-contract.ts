import { randomUUID } from 'node:crypto';

import {
  SEARCH_ERROR_CONTRACT_VERSION,
  type SearchApiErrorResponse,
} from '../../../shared/search-contract';
import type { SearchResponse } from '../types/search';

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
};

type ResponseLike = {
  setHeader?: (name: string, value: string) => unknown;
  status: (code: number) => ResponseLike;
  json: (payload: unknown) => ResponseLike;
};

const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

const getHeaderValue = (request: RequestLike, name: string) => {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

export const getRequestId = (request: RequestLike) => {
  const supplied = getHeaderValue(request, 'x-request-id')?.trim();
  return supplied && requestIdPattern.test(supplied) ? supplied : randomUUID();
};

export const setRequestIdHeader = (response: ResponseLike, requestId: string) => {
  response.setHeader?.('X-Request-Id', requestId);
};

export const withSearchRequestId = (
  response: SearchResponse,
  requestId: string,
): SearchResponse => {
  if (!response.meta) {
    return response;
  }

  return {
    ...response,
    meta: {
      ...response.meta,
      requestId,
    },
  };
};

export const sendSearchError = (
  response: ResponseLike,
  status: number,
  input: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    details?: unknown;
  },
) => {
  setRequestIdHeader(response, input.requestId);
  const payload: SearchApiErrorResponse = {
    error: input.message,
    code: input.code,
    retryable: input.retryable,
    requestId: input.requestId,
    contractVersion: SEARCH_ERROR_CONTRACT_VERSION,
    ...(input.details === undefined ? {} : { details: input.details }),
  };
  response.status(status).json(payload);
};
