import {
  SEARCH_RESPONSE_CONTRACT_VERSION,
  buildSearchResponseContract,
} from './search-contract.js';

export const buildIntegrationCapabilities = () => ({
  apiVersion: 'v1' as const,
  responseContractVersion: SEARCH_RESPONSE_CONTRACT_VERSION,
  authentication: {
    ownerRequired: true,
    acceptedHeaders: ['x-api-key', 'authorization'] as const,
    bearerFormat: 'Bearer <Supabase access token>',
    apiKeyFormat: 'x-api-key: <integration key>',
  },
  client: {
    packageName: 'lead-finder-integration-sdk',
    version: '0.1.0',
    runtime: 'fetch-compatible TypeScript/JavaScript',
  },
  modes: [
    {
      id: 'gmb' as const,
      name: 'Google Business',
      executionPaths: ['durable', 'stateless-fallback'] as const,
      contract: buildSearchResponseContract('gmb'),
    },
    {
      id: 'linkedin' as const,
      name: 'LinkedIn public profiles',
      executionPaths: ['durable', 'stateless'] as const,
      contract: buildSearchResponseContract('linkedin'),
    },
    {
      id: 'ai' as const,
      name: 'Free AI-assisted public discovery',
      executionPaths: ['durable', 'stateless'] as const,
      contract: buildSearchResponseContract('ai'),
    },
  ],
  operations: {
    start: 'POST /api/v1/search',
    poll: 'GET /api/v1/search/:searchId',
    evidence: 'GET /api/v1/search/:searchId/evidence',
    cancel: 'POST /api/v1/search/:searchId/cancel',
    resume: 'POST /api/v1/search/:searchId/resume',
    reverify: 'POST /api/v1/search/:searchId/reverify',
    feedback: 'POST /api/v1/search/:searchId/feedback',
  },
  guarantees: [
    'Every returned lead passed the mandatory public-phone evidence gate.',
    'Search retries can reuse the same bounded Idempotency-Key.',
    'Responses include request correlation and machine-readable error codes.',
    'Only public, legally accessible sources are used; provider credentials stay server-side.',
  ] as const,
});
