import { ZodError } from 'zod';
import { waitUntil } from '@vercel/functions';
import { searchRequestSchema } from '../_lib/search-contract.js';
import { getVercelSearchService } from '../_lib/vercel-search-service.js';
import { flattenSearchRequest } from '../../server/src/utils/search-location.js';
import {
  getRequestId,
  getIdempotencyKey,
  sendSearchError,
  setRequestIdHeader,
  withSearchRequestId,
} from '../../server/src/http/search-http-contract.js';
import { SearchIdempotencyConflictError } from '../../server/src/services/search-idempotency.js';
import { authorizeSearchRequest } from '../_lib/search-auth.js';
import { hasCallbackSigningSecret } from '../../server/src/services/search-completion-callback.js';

const isSearchPersistenceFailure = (error: unknown) =>
  error instanceof Error &&
  (error as Error & { code?: unknown }).code === 'SEARCH_PERSISTENCE_UNAVAILABLE';

const isVercelRuntime = () =>
  process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
const durableStorageEnvKeys = [
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL',
  'DATABASE_URL',
] as const;

const hasDurableSearchStorage = () =>
  durableStorageEnvKeys.some((key) => Boolean(process.env[key]?.trim()));

const runStatelessLinkedinSearchOnDemand = async (
  request: ReturnType<typeof flattenSearchRequest>,
) => {
  const { runStatelessLinkedinSearch } = await import(
    '../../server/src/services/linkedin-stateless-search.js'
  );

  return runStatelessLinkedinSearch(request);
};

const runStatelessAiSearchOnDemand = async (
  request: ReturnType<typeof flattenSearchRequest>,
) => {
  const { runStatelessAiSearch } = await import(
    '../../server/src/services/ai-lead-discovery.js'
  );

  return runStatelessAiSearch(request);
};

export default async function handler(req: any, res: any) {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  if (req.method !== 'POST') {
    sendSearchError(res, 405, {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed',
      retryable: false,
      requestId,
    });
    return;
  }

  let flattenedRequest: ReturnType<typeof flattenSearchRequest> | undefined;

  try {
    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    const auth = await authorizeSearchRequest(req, res, requestId);
    if (!auth) {
      return;
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (idempotencyKey === null) {
      sendSearchError(res, 400, {
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Invalid Idempotency-Key header',
        retryable: false,
        requestId,
      });
      return;
    }

    const payload = searchRequestSchema.parse(req.body);
    flattenedRequest = flattenSearchRequest(payload);

    if (flattenedRequest.callback) {
      if (!auth.ownerId) {
        sendSearchError(res, 401, {
          code: 'CALLBACK_OWNER_REQUIRED',
          message: 'Completion callbacks require an authenticated integration owner.',
          retryable: false,
          requestId,
        });
        return;
      }

      if (!hasDurableSearchStorage()) {
        sendSearchError(res, 503, {
          code: 'CALLBACK_REQUIRES_DURABLE_STORAGE',
          message: 'Completion callbacks require durable Postgres search storage.',
          retryable: false,
          requestId,
        });
        return;
      }

      if (!hasCallbackSigningSecret()) {
        sendSearchError(res, 503, {
          code: 'CALLBACK_SIGNING_NOT_CONFIGURED',
          message: 'Completion callbacks require LEAD_FINDER_INTEGRATION_CALLBACK_SIGNING_SECRET.',
          retryable: false,
          requestId,
        });
        return;
      }
    }

    if (
      isVercelRuntime() &&
      flattenedRequest.sourceMode === 'linkedin' &&
      !hasDurableSearchStorage()
    ) {
      try {
        const response = await runStatelessLinkedinSearchOnDemand(flattenedRequest);
        res.status(200).json(withSearchRequestId(response, requestId));
      } catch (error) {
        console.error('[api/search] stateless LinkedIn search failed', error);
        sendSearchError(res, 502, {
          code: 'PUBLIC_LINKEDIN_SEARCH_UNAVAILABLE',
          message: 'Public LinkedIn search could not be completed. Please try again.',
          retryable: true,
          requestId,
        });
      }
      return;
    }

    if (
      isVercelRuntime() &&
      flattenedRequest.sourceMode === 'ai' &&
      !hasDurableSearchStorage()
    ) {
      try {
        const response = await runStatelessAiSearchOnDemand(flattenedRequest);
        res.status(200).json(withSearchRequestId(response, requestId));
      } catch (error) {
        console.error('[api/search] stateless AI search failed', error);
        sendSearchError(res, 502, {
          code: 'FREE_AI_SEARCH_UNAVAILABLE',
          message: 'Free AI search could not be completed. Please try again.',
          retryable: true,
          requestId,
        });
      }
      return;
    }

    const service = await getVercelSearchService();
    const context = {
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(auth.ownerId ? { ownerId: auth.ownerId } : {}),
    };
    const response = Object.keys(context).length
      ? await service.startSearch(flattenedRequest, context)
      : await service.startSearch(flattenedRequest);

    waitUntil(
      (auth.ownerId
        ? service.advanceSearch(response.searchId, auth.ownerId)
        : service.advanceSearch(response.searchId)
      ).catch((error) => {
        console.error('[api/search] background search failed', error);
      }),
    );

    res.status(200).json(withSearchRequestId(response, requestId));
  } catch (error) {
    if (error instanceof ZodError) {
      sendSearchError(res, 400, {
        code: 'INVALID_SEARCH_REQUEST',
        message: 'Invalid search request',
        retryable: false,
        requestId,
        details: error.flatten(),
      });
      return;
    }

    if (error instanceof SearchIdempotencyConflictError) {
      sendSearchError(res, 409, {
        code: error.code,
        message: error.message,
        retryable: false,
        requestId,
      });
      return;
    }

    if (
      isSearchPersistenceFailure(error) &&
      (flattenedRequest?.sourceMode === 'linkedin' || flattenedRequest?.sourceMode === 'ai')
    ) {
      try {
        const response =
          flattenedRequest.sourceMode === 'ai'
            ? await runStatelessAiSearchOnDemand(flattenedRequest)
            : await runStatelessLinkedinSearchOnDemand(flattenedRequest);
        res.status(200).json(withSearchRequestId(response, requestId));
        return;
      } catch (fallbackError) {
        console.error('[api/search] stateless public fallback failed', fallbackError);
        sendSearchError(res, 502, {
          code:
            flattenedRequest.sourceMode === 'ai'
              ? 'FREE_AI_SEARCH_UNAVAILABLE'
              : 'PUBLIC_LINKEDIN_SEARCH_UNAVAILABLE',
          message:
            flattenedRequest.sourceMode === 'ai'
              ? 'Free AI search could not be completed. Please try again.'
              : 'Public LinkedIn search could not be completed. Please try again.',
          retryable: true,
          requestId,
        });
        return;
      }
    }

    if (isSearchPersistenceFailure(error)) {
      sendSearchError(res, 503, {
        code: 'SEARCH_PERSISTENCE_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Search persistence unavailable',
        retryable: false,
        requestId,
      });
      return;
    }

    sendSearchError(res, 500, {
      code: 'SEARCH_FAILED',
      message: error instanceof Error ? error.message : 'Search failed',
      retryable: true,
      requestId,
    });
  }
}
