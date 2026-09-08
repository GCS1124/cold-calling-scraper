import { beforeEach, describe, expect, it, vi } from 'vitest';

const legacyHandler = vi.hoisted(() => vi.fn());

vi.mock('../../../api/search/index.js', () => ({
  default: legacyHandler,
}));

import capabilitiesHandler from '../../../api/v1/capabilities';
import versionedSearchHandler from '../../../api/v1/search';

const createResponse = () => {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };

  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    json(payload: unknown) {
      state.body = payload;
      return response;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return response;
    },
  };

  return { response, state };
};

describe('versioned integration surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes capabilities without exposing provider credentials', () => {
    const { response, state } = createResponse();

    capabilitiesHandler({ method: 'GET', headers: {} }, response);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toContain('max-age=60');
    expect(state.body).toMatchObject({
      apiVersion: 'v1',
      responseContractVersion: 2,
      authentication: { ownerRequired: true },
      modes: [{ id: 'gmb' }, { id: 'linkedin' }, { id: 'ai' }],
    });
    const serialized = JSON.stringify(state.body);
    expect(serialized).not.toContain('GOOGLE_PLACES_API_KEY');
    expect(serialized).not.toContain('GEMINI_API_KEY');
    expect(serialized).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('publishes an OpenAPI document through the existing capabilities function', () => {
    const { response, state } = createResponse();

    capabilitiesHandler({ method: 'GET', query: { format: 'openapi' }, headers: {} }, response);

    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/api/v1/search': { post: { operationId: 'startSearch' } },
        '/api/v1/search/{searchId}/feedback': { post: { operationId: 'recordFeedback' } },
      },
    });
  });

  it('marks versioned search requests as owner-required before legacy handling', async () => {
    legacyHandler.mockResolvedValue(undefined);
    const request = { method: 'POST', headers: {} };
    const { response } = createResponse();

    await versionedSearchHandler(request, response);

    expect(request).toMatchObject({ requireAuthenticatedOwner: true });
    expect(legacyHandler).toHaveBeenCalledWith(request, response);
  });
});
