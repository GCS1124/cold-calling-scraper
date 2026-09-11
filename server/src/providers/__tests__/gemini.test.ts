import { afterEach, describe, expect, it, vi } from 'vitest';

const axiosPost = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: {
    post: axiosPost,
  },
}));

import {
  discoverLeadsWithGemini,
  expandQueryWithGemini,
  getGeminiApiKeyCount,
  getGeminiPoolHealth,
  GeminiKeyPoolError,
  GeminiRateLimitError,
  isGeminiLeadDiscoveryEnabled,
  isGeminiRateLimited,
  isGeminiRateLimitError,
  isGeminiQueryAssistanceEnabled,
  normalizeGeminiQueryHints,
  parseGroundedGeminiCandidates,
  resetGeminiRequestStateForTests,
} from '../gemini';

const originalApiKey = process.env.GEMINI_API_KEY;
const originalApiKeys = process.env.GEMINI_API_KEYS;
const originalNumberedApiKeys = Object.fromEntries(
  Array.from({ length: 20 }, (_, index) => {
    const name = `GEMINI_API_KEY_${index + 1}`;
    return [name, process.env[name]];
  }),
) as Record<string, string | undefined>;
const originalAssistanceFlag = process.env.GEMINI_QUERY_ASSISTANCE_ENABLED;
const originalDiscoveryFlag = process.env.GEMINI_LEAD_DISCOVERY_ENABLED;
const originalRetryConfig = Object.fromEntries(
  [
    'GEMINI_MIN_REQUEST_GAP_MS',
    'GEMINI_MAX_RETRIES',
    'GEMINI_MAX_RETRY_WAIT_MS',
    'GEMINI_RATE_LIMIT_COOLDOWN_MS',
    'GEMINI_FALLBACK_RETRY_MS',
    'GEMINI_AUTH_FAILURE_COOLDOWN_MS',
    'GEMINI_TRANSIENT_FAILURE_COOLDOWN_MS',
    'GEMINI_QUERY_CACHE_TTL_MS',
    'GEMINI_GROUNDED_CACHE_TTL_MS',
    'GEMINI_KEY_ROTATION_ATTEMPTS',
  ].map((name) => [name, process.env[name]]),
) as Record<string, string | undefined>;

afterEach(() => {
  vi.clearAllMocks();
  resetGeminiRequestStateForTests();
  for (const [name, value] of [
    ['GEMINI_API_KEY', originalApiKey],
    ['GEMINI_API_KEYS', originalApiKeys],
    ['GEMINI_QUERY_ASSISTANCE_ENABLED', originalAssistanceFlag],
    ['GEMINI_LEAD_DISCOVERY_ENABLED', originalDiscoveryFlag],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const [name, value] of Object.entries(originalNumberedApiKeys)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const [name, value] of Object.entries(originalRetryConfig)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('Gemini public research layer', () => {
  it('enables query and grounded discovery when a key exists unless explicitly disabled', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_QUERY_ASSISTANCE_ENABLED;
    delete process.env.GEMINI_LEAD_DISCOVERY_ENABLED;

    expect(isGeminiQueryAssistanceEnabled()).toBe(true);
    expect(isGeminiLeadDiscoveryEnabled()).toBe(true);

    process.env.GEMINI_LEAD_DISCOVERY_ENABLED = 'false';
    expect(isGeminiLeadDiscoveryEnabled()).toBe(false);
  });

  it('counts comma-separated pool keys without exposing their values', () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEYS = ' key-a, key-b\nkey-c;key-a ';

    expect(getGeminiApiKeyCount()).toBe(3);
    expect(isGeminiQueryAssistanceEnabled()).toBe(true);
  });

  it('reports aggregate pool health without exposing configured key values', () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEYS = 'private-key-one,private-key-two';

    const health = getGeminiPoolHealth();

    expect(health).toMatchObject({
      configuredKeyCount: 2,
      availableKeyCount: 2,
      coolingDownKeyCount: 0,
    });
    expect(JSON.stringify(health)).not.toContain('private-key');
  });

  it('reads numbered key variables and rotates through the full pool by default', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEYS;
    for (const [index, key] of ['key-one', 'key-two', 'key-three', 'key-four', 'key-five'].entries()) {
      process.env[`GEMINI_API_KEY_${index + 1}`] = key;
    }
    process.env.GEMINI_MAX_RETRIES = '0';
    process.env.GEMINI_MIN_REQUEST_GAP_MS = '0';
    process.env.GEMINI_RATE_LIMIT_COOLDOWN_MS = '60_000';
    delete process.env.GEMINI_KEY_ROTATION_ATTEMPTS;
    axiosPost.mockRejectedValue({
      message: '429 Too Many Requests',
      response: { headers: {} },
    });

    await expect(expandQueryWithGemini('HVAC in Austin, TX', {
      companyType: 'HVAC contractor',
      city: 'Austin, TX',
      count: 50,
    })).rejects.toBeInstanceOf(GeminiRateLimitError);

    expect(axiosPost).toHaveBeenCalledTimes(5);
    expect(axiosPost.mock.calls.map((call) => (
      (call[2] as { headers?: Record<string, string> }).headers?.['x-goog-api-key']
    ))).toEqual(['key-one', 'key-two', 'key-three', 'key-four', 'key-five']);
  });

  it('does not append the raw JSON response as a search hint', () => {
    const hints = normalizeGeminiQueryHints(
      JSON.stringify({
        queries: ['HVAC owner Austin', 'HVAC company founder Austin'],
      }),
      ['HVAC contractor Austin'],
    );

    expect(hints).toEqual([
      'HVAC owner Austin',
      'HVAC company founder Austin',
      'HVAC contractor Austin',
    ]);
    expect(hints.some((hint) => hint.startsWith('{'))).toBe(false);
  });

  it('retains grounded model details without treating contact fields as verified', () => {
    const result = parseGroundedGeminiCandidates({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  candidates: [
                    {
                      name: 'Avery Smith',
                      organizationName: 'Austin Dental Studio',
                      role: 'Owner',
                      location: 'Austin, TX',
                      website: 'https://austindental.example',
                      phone: '+1 512 555 0100',
                      email: 'avery@austindental.example',
                      sourceUrls: ['https://austindental.example/about?utm_source=gemini'],
                      socialLinks: [
                        { platform: 'LinkedIn', url: 'https://www.linkedin.com/in/avery-smith' },
                        { platform: 'Instagram', url: 'https://www.instagram.com/austindental' },
                      ],
                      evidence: 'The about page identifies Avery Smith as owner.',
                    },
                  ],
                }),
              },
            ],
          },
          groundingMetadata: {
            groundingChunks: [
              {
                web: {
                  uri: 'https://austindental.example/about',
                  title: 'Austin Dental Studio - About',
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.groundingSources).toEqual([
      {
        url: 'https://austindental.example/about',
        title: 'Austin Dental Studio - About',
      },
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      name: 'Avery Smith',
      personName: 'Avery Smith',
      organizationName: 'Austin Dental Studio',
      reportedPhone: '+1 512 555 0100',
      reportedEmail: 'avery@austindental.example',
      socialLinks: [
        { platform: 'LinkedIn', url: 'https://www.linkedin.com/in/avery-smith' },
        { platform: 'Instagram', url: 'https://www.instagram.com/austindental' },
      ],
      grounded: true,
      status: 'needs_phone_validation',
    });
  });

  it('keeps a candidate for review when the model source is not grounded', () => {
    const result = parseGroundedGeminiCandidates({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  candidates: [
                    {
                      name: 'Unmatched Public Candidate',
                      organizationName: 'Example HVAC',
                      sourceUrls: ['https://example-hvac.example/about'],
                      evidence: 'Needs source review.',
                    },
                  ],
                }),
              },
            ],
          },
          groundingMetadata: { groundingChunks: [] },
        },
      ],
    });

    expect(result.candidates[0]).toMatchObject({
      grounded: false,
      status: 'needs_source_review',
    });
  });

  it('retains contact-only details and normalizes object or plain-url sources', () => {
    const result = parseGroundedGeminiCandidates({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  results: [
                    {
                      phone: '+1 512 555 0199',
                      email: 'office@example-hvac.test',
                      socialLinks: ['https://www.facebook.com/example-hvac'],
                      sources: [
                        {
                          url: 'https://example-hvac.test/contact?utm_source=gemini',
                          title: 'Example HVAC Contact',
                        },
                      ],
                    },
                  ],
                }),
              },
            ],
          },
          groundingMetadata: {
            groundingChunks: [
              {
                web: {
                  uri: 'https://example-hvac.test/contact?gclid=public-search',
                  title: 'Example HVAC Contact',
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      reportedPhone: '+1 512 555 0199',
      reportedEmail: 'office@example-hvac.test',
      socialLinks: [
        { platform: 'Facebook', url: 'https://www.facebook.com/example-hvac' },
      ],
      sourceUrls: [
        'https://example-hvac.test/contact?utm_source=gemini',
        'https://www.facebook.com/example-hvac',
      ],
      sourceTitles: ['Example HVAC Contact'],
      grounded: true,
      status: 'needs_phone_validation',
    });
  });

  it('sends public Google Business listing seeds to the grounded enrichment request', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_LEAD_DISCOVERY_ENABLED;
    axiosPost.mockResolvedValue({
      data: {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ candidates: [] }) }],
            },
            groundingMetadata: { groundingChunks: [] },
          },
        ],
      },
    });

    await discoverLeadsWithGemini(
      { companyType: 'Dentist', city: 'Austin, TX', count: 50 },
      'Austin, TX',
      [
        {
          name: 'Austin Dental Studio',
          address: 'Austin, TX',
          listingUrl: 'https://www.google.com/maps/search/?api=1&query=Austin%20Dental%20Studio',
          mobile: '+1 512 555 0198',
          source: 'Google Places',
        },
      ],
    );

    const requestBody = axiosPost.mock.calls[0]?.[1] as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const requestConfig = axiosPost.mock.calls[0]?.[2] as {
      headers?: Record<string, string>;
    };
    const prompt = requestBody.contents?.[0]?.parts?.[0]?.text ?? '';

    expect(prompt).toContain('Public Google Business (GMB) and other business-listing seeds to enrich');
    expect(prompt).toContain('Austin Dental Studio');
    expect(prompt).toContain('publicPhone');
    expect(prompt).toContain('google.com/maps/search');
    expect(requestConfig.headers?.['x-goog-api-key']).toBe('test-key');
  });

  it('serializes and retries a short-lived free-tier 429 once', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MAX_RETRIES = '1';
    process.env.GEMINI_MIN_REQUEST_GAP_MS = '0';
    process.env.GEMINI_MAX_RETRY_WAIT_MS = '100';
    process.env.GEMINI_RATE_LIMIT_COOLDOWN_MS = '0';
    process.env.GEMINI_FALLBACK_RETRY_MS = '0';
    axiosPost
      .mockRejectedValueOnce({
        message: 'Request failed with status code 429',
        response: { status: 429, headers: { 'retry-after': '0' } },
      })
      .mockResolvedValueOnce({
        data: {
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(['HVAC owner Austin']) }],
              },
            },
          ],
        },
      });

    await expect(
      expandQueryWithGemini('HVAC contractor in Austin, TX', {
        companyType: 'HVAC contractor',
        city: 'Austin, TX',
        count: 50,
      }),
    ).resolves.toEqual(['HVAC owner Austin']);
    expect(axiosPost).toHaveBeenCalledTimes(2);
  });

  it('reuses a successful query plan without spending another key', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_QUERY_CACHE_TTL_MS = '60_000';
    process.env.GEMINI_MIN_REQUEST_GAP_MS = '0';
    axiosPost.mockResolvedValue({
      data: {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(['HVAC owner Austin']) }],
            },
          },
        ],
      },
    });

    const request = {
      companyType: 'HVAC contractor',
      city: 'Austin, TX',
      count: 50,
    };
    await expect(expandQueryWithGemini('HVAC in Austin, TX', request)).resolves.toEqual([
      'HVAC owner Austin',
    ]);
    await expect(expandQueryWithGemini('HVAC in Austin, TX', request)).resolves.toEqual([
      'HVAC owner Austin',
    ]);

    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it('raises a typed rate-limit error after the bounded retry budget is exhausted', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MAX_RETRIES = '0';
    process.env.GEMINI_MIN_REQUEST_GAP_MS = '0';
    process.env.GEMINI_RATE_LIMIT_COOLDOWN_MS = '60_000';
    axiosPost.mockRejectedValueOnce({
      message: 'Request failed with status code 429',
      response: { status: 429, headers: {} },
    });

    let caught: unknown;
    try {
      await expandQueryWithGemini('Dentist in Austin, TX', {
        companyType: 'Dentist',
        city: 'Austin, TX',
        count: 50,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GeminiRateLimitError);
    expect(isGeminiRateLimitError(caught)).toBe(true);
    expect((caught as GeminiRateLimitError).message).toContain('free-tier quota');
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it('rotates across every configured key before falling back on quota pressure', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEYS = 'key-a,key-b,key-c,key-d,key-e';
    process.env.GEMINI_MAX_RETRIES = '0';
    process.env.GEMINI_KEY_ROTATION_ATTEMPTS = '5';
    process.env.GEMINI_MIN_REQUEST_GAP_MS = '0';
    process.env.GEMINI_RATE_LIMIT_COOLDOWN_MS = '60_000';
    axiosPost.mockRejectedValue({
      message: 'Request failed with status code 429',
      response: { status: 429, headers: {} },
    });

    await expect(
      expandQueryWithGemini('HVAC in Austin, TX', {
        companyType: 'HVAC contractor',
        city: 'Austin, TX',
        count: 50,
      }),
    ).rejects.toBeInstanceOf(GeminiRateLimitError);

    expect(axiosPost).toHaveBeenCalledTimes(5);
    expect(axiosPost.mock.calls.map((call) => (
      (call[2] as { headers?: Record<string, string> }).headers?.['x-goog-api-key']
    ))).toEqual(['key-a', 'key-b', 'key-c', 'key-d', 'key-e']);
    expect(isGeminiRateLimited()).toBe(true);
  });

  it('skips an invalid key and succeeds with the next configured key', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEYS = 'invalid-key,healthy-key';
    process.env.GEMINI_KEY_ROTATION_ATTEMPTS = '2';
    process.env.GEMINI_MIN_REQUEST_GAP_MS = '0';
    process.env.GEMINI_AUTH_FAILURE_COOLDOWN_MS = '10_000';
    axiosPost
      .mockRejectedValueOnce({
        message: 'Request failed with status code 403',
        response: { status: 403, headers: {} },
      })
      .mockResolvedValueOnce({
        data: {
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(['HVAC owner Austin']) }],
              },
            },
          ],
        },
      });

    await expect(
      expandQueryWithGemini('HVAC in Austin, TX', {
        companyType: 'HVAC contractor',
        city: 'Austin, TX',
        count: 50,
      }),
    ).resolves.toEqual(['HVAC owner Austin']);

    expect(axiosPost).toHaveBeenCalledTimes(2);
    expect(axiosPost.mock.calls.map((call) => (
      (call[2] as { headers?: Record<string, string> }).headers?.['x-goog-api-key']
    ))).toEqual(['invalid-key', 'healthy-key']);
  });

  it('returns a non-secret pool error when every configured key has a transient failure', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEYS = 'key-a,key-b';
    process.env.GEMINI_KEY_ROTATION_ATTEMPTS = '2';
    process.env.GEMINI_MIN_REQUEST_GAP_MS = '0';
    process.env.GEMINI_TRANSIENT_FAILURE_COOLDOWN_MS = '0';
    axiosPost.mockRejectedValue({
      message: 'upstream unavailable',
      code: 'ECONNRESET',
    });

    await expect(
      expandQueryWithGemini('Dentist in Austin, TX', {
        companyType: 'Dentist',
        city: 'Austin, TX',
        count: 50,
      }),
    ).rejects.toBeInstanceOf(GeminiKeyPoolError);
    expect(axiosPost).toHaveBeenCalledTimes(2);
  });

  it('briefly caches identical grounded research requests during durable retries', async () => {
    process.env.GEMINI_API_KEY = 'grounded-cache-key';
    delete process.env.GEMINI_LEAD_DISCOVERY_ENABLED;
    process.env.GEMINI_GROUNDED_CACHE_TTL_MS = '60_000';
    process.env.GEMINI_MIN_REQUEST_GAP_MS = '0';
    axiosPost.mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify({ candidates: [] }) }],
          },
          groundingMetadata: { groundingChunks: [] },
        }],
      },
    });
    const request = { companyType: 'Dentist', city: 'Austin, TX', count: 50 } as const;

    await discoverLeadsWithGemini(request, 'Austin, TX', [], 'Austin, TX', 5_000);
    await discoverLeadsWithGemini(request, 'Austin, TX', [], 'Austin, TX', 5_000);

    expect(axiosPost).toHaveBeenCalledOnce();
  });
});
