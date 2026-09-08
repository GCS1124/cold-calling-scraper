import { describe, expect, it } from 'vitest';

import type { ResearchCandidate } from '../../types/lead';
import type { SearchRequest } from '../../types/search';
import { buildLeadsFromGeminiCandidates } from '../gemini-lead-discovery';

const request: SearchRequest = {
  companyType: 'Dentist',
  sourceMode: 'ai',
  city: 'Austin, TX',
  count: 50,
  phoneRequired: true,
};

describe('Gemini AI-mode lead mapping', () => {
  it('keeps grounded person and public social evidence without trusting model-reported contact data', () => {
    const candidate: ResearchCandidate = {
      id: 'candidate-1',
      name: 'Austin Dental Studio',
      personName: 'Avery Smith',
      organizationName: 'Austin Dental Studio',
      originalRole: 'Owner',
      location: 'Austin, TX',
      website: 'https://austindental.example',
      profileUrl: 'https://www.linkedin.com/in/avery-smith',
      reportedPhone: '+1 512 555 0100',
      reportedEmail: 'avery@austindental.example',
      socialLinks: [
        { platform: 'LinkedIn', url: 'https://www.linkedin.com/in/avery-smith' },
        { platform: 'Instagram', url: 'https://www.instagram.com/austindental' },
      ],
      sourceUrls: ['https://austindental.example/about'],
      sourceTitles: ['About Austin Dental Studio'],
      evidence: 'Avery Smith is listed as owner on the public about page.',
      grounded: true,
      status: 'needs_phone_validation',
      discoveredAt: '2026-09-09T00:00:00.000Z',
    };

    const [lead] = buildLeadsFromGeminiCandidates([candidate], request, 'Austin, TX');

    expect(lead).toMatchObject({
      name: 'Austin Dental Studio',
      organizationName: 'Austin Dental Studio',
      decisionMakerName: 'Avery Smith',
      decisionMakerRole: 'Owner',
      decisionMakerSourceUrl: 'https://www.linkedin.com/in/avery-smith',
      website: 'https://austindental.example',
      hasPhone: false,
      hasEmail: false,
      mobile: '',
      email: '',
    });
    expect(lead?.publicSocialLinks).toEqual([
      { platform: 'LinkedIn', url: 'https://www.linkedin.com/in/avery-smith' },
      { platform: 'Instagram', url: 'https://www.instagram.com/austindental' },
    ]);
    expect(lead?.publicEvidence?.profileSnippet).toContain('owner');
  });
});
