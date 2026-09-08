import { enforceIntegrationRateLimit } from '../../server/src/http/integration-rate-limit.js';

type VercelHandler = (request: any, response: any) => unknown;

/** Marks only the versioned integration route as owner-required. */
export const requireIntegrationOwner = (handler: VercelHandler): VercelHandler =>
  async (request, response) => {
    request.requireAuthenticatedOwner = true;
    if (!(await enforceIntegrationRateLimit(request, response))) return;
    return handler(request, response);
  };
