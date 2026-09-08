import {
  authenticateSearchRequest,
  isSearchAuthorizationError,
  type SearchAuthContext,
} from '../../server/src/auth/search-auth.js';
import { sendSearchError } from '../../server/src/http/search-http-contract.js';

export const authorizeSearchRequest = async (
  request: any,
  response: any,
  requestId: string,
): Promise<SearchAuthContext | null> => {
  try {
    const auth = await authenticateSearchRequest(request);
    if (request.requireAuthenticatedOwner === true) {
      request.integrationAuthContext = auth;
    }
    return auth;
  } catch (error) {
    if (!isSearchAuthorizationError(error)) {
      throw error;
    }

    sendSearchError(response, error.status, {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId,
    });
    return null;
  }
};
