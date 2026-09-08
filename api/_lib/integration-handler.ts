import { enforceIntegrationRateLimit } from '../../server/src/http/integration-rate-limit.js';
import {
  ensureIntegrationAuditReady,
  recordIntegrationAuditEvent,
} from '../../server/src/services/integration-audit-log.js';
import { getRequestId, sendSearchError } from '../../server/src/http/search-http-contract.js';
import { isSearchPersistenceError } from '../../server/src/services/search-job-store.js';

type VercelHandler = (request: any, response: any) => unknown;

const getPath = (request: any) => {
  const rawUrl = typeof request.url === 'string' ? request.url : '/api/v1';
  return rawUrl.split(/[?#]/, 1)[0].slice(0, 256) || '/api/v1';
};

const getOperation = (request: any) => {
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'UNKNOWN';
  return `${method} ${getPath(request)}`;
};

const getOutcome = (statusCode: number): 'completed' | 'failed' | 'rejected' => {
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) return 'rejected';
  if (statusCode >= 400) return 'failed';
  return 'completed';
};

const getErrorCode = (error: unknown) => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
};

/** Marks only the versioned integration route as owner-required. */
export const requireIntegrationOwner = (handler: VercelHandler): VercelHandler =>
  async (request, response) => {
    request.requireAuthenticatedOwner = true;
    if (!(await enforceIntegrationRateLimit(request, response))) return;

    try {
      await ensureIntegrationAuditReady();
    } catch (error) {
      const requestId = getRequestId(request);
      sendSearchError(response, 503, {
        code: isSearchPersistenceError(error)
          ? error.code
          : 'INTEGRATION_AUDIT_UNAVAILABLE',
        message:
          error instanceof Error
            ? error.message
            : 'Integration audit logging is temporarily unavailable.',
        retryable: true,
        requestId,
      });
      return;
    }

    let thrownError: unknown;
    try {
      return await handler(request, response);
    } catch (error) {
      thrownError = error;
      throw error;
    } finally {
      const statusCode = Number(response.statusCode) || (thrownError ? 500 : 200);
      const auth = request.integrationAuthContext;

      try {
        await recordIntegrationAuditEvent({
          requestId: getRequestId(request),
          ownerId: auth?.ownerId,
          apiKeyId: auth?.apiKeyId,
          method: typeof request.method === 'string' ? request.method : 'UNKNOWN',
          path: getPath(request),
          operation: getOperation(request),
          outcome: getOutcome(statusCode),
          statusCode,
          errorCode: getErrorCode(thrownError),
        });
      } catch (auditError) {
        console.error('[integration-handler] audit write failed', auditError);
      }
    }
  };
