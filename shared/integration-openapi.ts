export const buildIntegrationOpenApi = () => ({
  openapi: '3.1.0',
  info: {
    title: 'Lead Finder Integration API',
    version: '1.0.0',
    description:
      'Provider-agnostic public lead discovery for Google Business, public LinkedIn, and free AI-assisted research. Every returned lead must satisfy the public-phone evidence policy.',
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
        summary: 'Start one GMB, public LinkedIn, or free AI search.',
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
          sourceMode: { type: 'string', enum: ['gmb', 'linkedin', 'ai'], default: 'gmb' },
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
          filters: { type: 'object', additionalProperties: true },
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
      SearchResponse: {
        type: 'object',
        required: ['searchId', 'leads', 'meta'],
        properties: {
          contractVersion: { type: 'integer' },
          searchId: { type: 'string' },
          leads: { type: 'array', items: { $ref: '#/components/schemas/Lead' } },
          meta: { type: 'object', additionalProperties: true },
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
