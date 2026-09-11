export const buildIntegrationOpenApi = () => ({
  openapi: '3.1.0',
  info: {
    title: 'Lead Finder Integration API',
    version: '1.0.0',
    description:
      'Provider-agnostic public lead discovery for Google Business and AI-mode public-source fusion, including indexed NotaryCafe profile references. Every returned lead must satisfy the public-phone evidence policy.',
  },
  servers: [{ url: '/', description: 'Current Lead Finder deployment' }],
  security: [{ apiKey: [] }, { bearerAuth: [] }],
  paths: {
    '/api/v1/capabilities': {
      get: {
        operationId: 'getCapabilities',
        security: [],
        parameters: [
          {
            name: 'format',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['openapi'] },
            description: 'Return this machine-readable OpenAPI document.',
          },
        ],
        responses: {
          '200': { description: 'Capabilities or OpenAPI document.' },
          '405': { $ref: '#/components/responses/MethodNotAllowed' },
        },
      },
    },
    '/api/v1/search': {
      post: {
        operationId: 'startSearch',
        summary: 'Start one GMB or AI public-source-fusion search.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SearchRequest' } },
          },
        },
        responses: {
          '200': { description: 'Initial or final search response.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '409': { $ref: '#/components/responses/Conflict' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/Unavailable' },
        },
      },
    },
    '/api/v1/search/{searchId}': {
      get: {
        operationId: 'getSearch',
        parameters: [{ $ref: '#/components/parameters/SearchId' }],
        responses: {
          '200': { description: 'Search snapshot.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/api/v1/search/{searchId}/evidence': {
      get: {
        operationId: 'getEvidence',
        parameters: [
          { $ref: '#/components/parameters/SearchId' },
          {
            name: 'leadId',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 128 },
          },
        ],
        responses: {
          '200': { description: 'Source-backed research dossier.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/search/{searchId}/cancel': {
      post: {
        operationId: 'cancelSearch',
        parameters: [{ $ref: '#/components/parameters/SearchId' }],
        responses: {
          '200': { description: 'Updated search snapshot.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/search/{searchId}/resume': {
      post: {
        operationId: 'resumeSearch',
        parameters: [{ $ref: '#/components/parameters/SearchId' }],
        responses: {
          '200': { description: 'Updated search snapshot.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/search/{searchId}/reverify': {
      post: {
        operationId: 'reverifySearch',
        parameters: [{ $ref: '#/components/parameters/SearchId' }],
        responses: {
          '200': { description: 'Updated search snapshot.' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/search/{searchId}/feedback': {
      post: {
        operationId: 'recordFeedback',
        parameters: [{ $ref: '#/components/parameters/SearchId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/FeedbackRequest' } },
          },
        },
        responses: {
          '200': { description: 'Updated search response.' },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    parameters: {
      SearchId: {
        name: 'searchId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 8, maxLength: 128 },
      },
    },
    responses: {
      BadRequest: { description: 'Invalid request.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unauthorized: { description: 'Authentication failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Conflict: { description: 'Idempotency conflict.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      MethodNotAllowed: { description: 'HTTP method is not supported.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      NotFound: { description: 'Search was not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      RateLimited: { description: 'Credential rate limit exceeded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unavailable: { description: 'Required service is unavailable.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    schemas: {
      SearchRequest: {
        type: 'object',
        required: ['companyType', 'location', 'count', 'phoneRequired'],
        properties: {
          companyType: { type: 'string', minLength: 2, maxLength: 120 },
          sourceMode: { type: 'string', enum: ['gmb', 'ai'], default: 'gmb' },
          researchDepth: { type: 'string', enum: ['quick', 'verified', 'pro'], default: 'verified' },
          researchBrief: { type: 'string', maxLength: 1_000 },
          location: {
            oneOf: [
              { type: 'object', required: ['mode', 'timeZone'], properties: { mode: { const: 'timezone' }, timeZone: { type: 'string', enum: ['EST', 'CST', 'MST', 'PST'] } } },
              { type: 'object', required: ['mode', 'city', 'stateCode'], properties: { mode: { const: 'cityState' }, city: { type: 'string', minLength: 2, maxLength: 120 }, stateCode: { type: 'string', pattern: '^[A-Z]{2}$' } } },
            ],
          },
          count: { type: 'integer', minimum: 50, maximum: 500 },
          phoneRequired: { const: true, description: 'Must remain true. Every returned lead needs public phone evidence.' },
          callback: { $ref: '#/components/schemas/CompletionCallbackRequest' },
          filters: { type: 'object', additionalProperties: true },
        },
        additionalProperties: false,
      },
      CompletionCallbackRequest: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            pattern: '^https://',
            maxLength: 2_048,
            description:
              'Public HTTPS endpoint without credentials, query, or fragment. The server signs the JSON body with LEAD_FINDER_INTEGRATION_CALLBACK_SIGNING_SECRET.',
          },
        },
        additionalProperties: false,
      },
      FeedbackRequest: {
        type: 'object',
        required: ['leadId', 'eventType'],
        properties: {
          leadId: { type: 'string', minLength: 1, maxLength: 128 },
          eventType: { type: 'string', enum: ['wrong_phone', 'wrong_business', 'wrong_person', 'former_employee', 'duplicate', 'do_not_contact', 'useful'] },
          reason: { type: 'string', maxLength: 500 },
        },
        additionalProperties: false,
      },
      Lead: {
        type: 'object',
        required: ['id', 'name', 'hasPhone', 'verifiedPhone'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          organizationName: { type: 'string' },
          originalRole: { type: 'string' },
          normalizedRole: { type: 'string' },
          decisionMakerName: { type: 'string', description: 'Explicitly published public decision-maker name.' },
          decisionMakerRole: { type: 'string' },
          decisionMakerSourceUrl: { type: 'string', format: 'uri' },
          decisionMakerPhonePair: {
            type: 'object',
            description: 'Derived public-evidence pairing state; paired does not claim personal ownership of the phone.',
            properties: {
              status: { type: 'string', enum: ['paired', 'decision_maker_only', 'phone_only', 'unpaired'] },
              phoneAssociation: { type: 'string', enum: ['business', 'person', 'unknown'] },
              phoneSourceUrl: { type: 'string', format: 'uri' },
              phoneSourceName: { type: 'string' },
              personSourceUrl: { type: 'string', format: 'uri' },
            },
            additionalProperties: false,
          },
          decisionMaker: { type: 'boolean' },
          mobile: { type: 'string', description: 'Publicly observed business or contact phone; not guaranteed personal or mobile.' },
          email: { type: 'string' },
          website: { type: 'string', format: 'uri' },
          contactSourceUrl: { type: 'string', format: 'uri' },
          evidence: { type: 'array', items: { type: 'object', additionalProperties: true } },
          hasPhone: { type: 'boolean', const: true },
          verifiedPhone: { type: 'boolean', const: true },
        },
        additionalProperties: true,
      },
      ProviderCoverage: {
        type: 'object',
        required: ['providerId', 'providerName', 'status', 'leadCount'],
        description: 'Provider lifecycle and count telemetry. leadCount remains the backward-compatible accepted-record count.',
        properties: {
          providerId: { type: 'string' },
          providerName: { type: 'string' },
          status: { type: 'string', enum: ['configured', 'not_configured', 'returned', 'failed', 'partial'] },
          leadCount: { type: 'integer', minimum: 0, description: 'Backward-compatible alias for acceptedCount.' },
          phase: { type: 'string', enum: ['queued', 'running', 'completed', 'degraded', 'skipped'] },
          outcome: { type: 'string', enum: ['not_started', 'returned', 'empty', 'timed_out', 'blocked', 'rate_limited', 'failed', 'filtered', 'deferred', 'not_configured'] },
          attemptedCount: { type: 'integer', minimum: 0 },
          observedCount: { type: 'integer', minimum: 0 },
          acceptedCount: { type: 'integer', minimum: 0 },
          reviewCount: { type: 'integer', minimum: 0 },
          deferredCount: { type: 'integer', minimum: 0 },
          completedCount: { type: 'integer', minimum: 0 },
          enrichedCount: { type: 'integer', minimum: 0 },
          blockedCount: { type: 'integer', minimum: 0 },
          timedOutCount: { type: 'integer', minimum: 0 },
          skippedCount: { type: 'integer', minimum: 0 },
          decisionMakerRecoveredCount: { type: 'integer', minimum: 0 },
          updatedAt: { type: 'string', format: 'date-time' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      ReviewCandidate: {
        type: 'object',
        required: ['id', 'providerId', 'providerName', 'reason', 'sourceUrls', 'discoveredAt'],
        description: 'Useful public evidence held outside exports until it independently passes the required public-phone and source gates.',
        properties: {
          id: { type: 'string' },
          providerId: { type: 'string' },
          providerName: { type: 'string' },
          reason: { type: 'string', enum: ['missing_public_phone', 'invalid_public_phone', 'missing_source_evidence', 'category_mismatch', 'location_mismatch', 'organization_unmatched', 'organization_ambiguous', 'former_or_conflicting', 'website_timeout', 'website_blocked', 'provider_timeout', 'provider_blocked', 'provider_rate_limited', 'deferred_by_budget'] },
          reasonDetail: { type: 'string' },
          name: { type: 'string' },
          personName: { type: 'string' },
          organizationName: { type: 'string' },
          originalRole: { type: 'string' },
          location: { type: 'string' },
          website: { type: 'string', format: 'uri' },
          profileUrl: { type: 'string', format: 'uri' },
          reportedPhone: { type: 'string', description: 'Publicly reported only; not verified or exportable.' },
          reportedEmail: { type: 'string', description: 'Publicly reported only; not verified or exportable.' },
          sourceUrls: { type: 'array', items: { type: 'string', format: 'uri' } },
          sourceTitles: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
          relatedLeadIds: { type: 'array', items: { type: 'string' } },
          discoveredAt: { type: 'string', format: 'date-time' },
        },
        additionalProperties: false,
      },
      SearchResponse: {
        type: 'object',
        required: ['searchId', 'leads', 'meta'],
        properties: {
          contractVersion: { type: 'integer' },
          searchId: { type: 'string' },
          leads: { type: 'array', items: { $ref: '#/components/schemas/Lead' } },
          researchCandidates: {
            type: 'array',
            description: 'Grounded model research held separately from exportable leads.',
            items: { type: 'object', additionalProperties: true },
          },
          reviewCandidates: {
            type: 'array',
            description: 'Provider-neutral public candidates excluded from export pending independent review.',
            items: { $ref: '#/components/schemas/ReviewCandidate' },
          },
          meta: {
            type: 'object',
            properties: {
              progress: {
                type: 'object',
                properties: {
                  providerCoverage: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ProviderCoverage' },
                  },
                },
                additionalProperties: true,
              },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      Error: {
        type: 'object',
        required: ['error', 'code', 'retryable', 'requestId', 'contractVersion'],
        properties: {
          error: { type: 'string' },
          code: { type: 'string' },
          retryable: { type: 'boolean' },
          requestId: { type: 'string' },
          contractVersion: { const: 1 },
          details: {},
        },
      },
    },
  },
} as const);
