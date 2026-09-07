import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authenticateSearchRequest,
  SearchAuthorizationError,
} from '../search-auth';

describe('search authentication', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps local development compatible when auth is optional and no token is supplied', async () => {
    await expect(authenticateSearchRequest({ headers: {} })).resolves.toEqual({});
  });

  it('fails closed when required auth has no bearer token', async () => {
    vi.stubEnv('LEAD_FINDER_AUTH_REQUIRED', 'true');

    await expect(authenticateSearchRequest({ headers: {} })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
      retryable: false,
    });
  });

  it('verifies the bearer token against Supabase Auth and returns the user id', async () => {
    vi.stubEnv('LEAD_FINDER_AUTH_REQUIRED', 'true');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'publishable-key');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'user-123' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      authenticateSearchRequest({
        headers: { Authorization: 'Bearer access-token' },
      }),
    ).resolves.toEqual({ ownerId: 'user-123' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/auth/v1/user',
      expect.objectContaining({
        headers: {
          apikey: 'publishable-key',
          Authorization: 'Bearer access-token',
        },
        cache: 'no-store',
      }),
    );
  });

  it('rejects an expired or invalid token without exposing provider details', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('invalid', { status: 401 })),
    );

    const failure = authenticateSearchRequest({
      headers: { authorization: 'Bearer expired-token' },
    });

    await expect(failure).rejects.toBeInstanceOf(SearchAuthorizationError);
    await expect(failure).rejects.toMatchObject({
      code: 'AUTH_INVALID',
      status: 401,
      message: 'Your sign-in session is invalid or expired.',
    });
  });

  it('does not accept a bearer token when server verification is unconfigured', async () => {
    await expect(
      authenticateSearchRequest({ headers: { authorization: 'Bearer token' } }),
    ).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
      status: 503,
    });
  });
});
