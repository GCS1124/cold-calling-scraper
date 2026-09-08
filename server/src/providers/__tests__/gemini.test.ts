import { afterEach, describe, expect, it } from 'vitest';

import {
  isGeminiLeadDiscoveryEnabled,
  isGeminiQueryAssistanceEnabled,
  normalizeGeminiQueryHints,
  parseGroundedGeminiCandidates,
} from '../gemini';

const originalApiKey = process.env.GEMINI_API_KEY;
const originalAssistanceFlag = process.env.GEMINI_QUERY_ASSISTANCE_ENABLED;
const originalDiscoveryFlag = process.env.GEMINI_LEAD_DISCOVERY_ENABLED;

afterEach(() => {
  for (const [name, value] of [
    ['GEMINI_API_KEY', originalApiKey],
    ['GEMINI_QUERY_ASSISTANCE_ENABLED', originalAssistanceFlag],
    ['GEMINI_LEAD_DISCOVERY_ENABLED', originalDiscoveryFlag],
  ] as const) {
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
});
