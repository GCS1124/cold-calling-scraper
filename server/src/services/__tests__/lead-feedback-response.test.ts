import { describe, expect, it } from 'vitest';

import type { Lead } from '../../types/lead';
import { getLeadFeedbackSuppressionKeys } from '../../../../shared/lead-feedback';
import { createSearchJobRecord, toSearchResponse } from '../search-job-store';

const lead: Lead = {
  id: 'response-lead',
  name: 'North Star HVAC',
  organizationName: 'North Star HVAC',
  mobile: '(512) 555-0100',
  email: '',
  website: 'https://northstar-hvac.example',
  listingUrl: 'https://www.google.com/maps/place/North+Star+HVAC',
  category: 'HVAC contractor',
  city: 'Austin',
  state: 'Texas',
  stateCode: 'TX',
  source: 'Google Places',
  confidence: 90,
  hasEmail: false,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: false,
  scrapedAt: '2026-09-08T00:00:00.000Z',
};

describe('search response feedback filtering', () => {
  it('hides only owner-suppressed qualified leads without weakening phone policy', () => {
    const job = createSearchJobRecord({
      searchId: 'feedback-response',
      request: {
        companyType: 'HVAC contractor',
        sourceMode: 'ai',
        city: 'Austin, TX',
        count: 50,
        phoneRequired: true,
      },
      query: 'HVAC contractor in Austin, TX',
      locationLabel: 'Austin, TX',
      locationMode: 'local',
      status: 'complete',
      leads: [lead],
      progress: {
        discovered: 1,
        enriched: 1,
        totalCandidates: 1,
        requestedCount: 50,
        foundCount: 1,
        duplicatesRemoved: 0,
        currentSource: 'Complete',
        batchesCompleted: 1,
        estimatedRemaining: 49,
      },
    });

    const response = toSearchResponse(
      job,
      new Set(getLeadFeedbackSuppressionKeys(lead, 'do_not_contact')),
    );

    expect(response.leads).toEqual([]);
    expect(response.meta.status).toBe('complete');
    expect(response.meta.progress.suppressedCount).toBe(1);
    expect(response.meta.providerWarnings).toContainEqual(
      expect.objectContaining({ providerId: 'workspace-suppression' }),
    );
    expect(response.meta.providerWarnings).not.toContainEqual(
      expect.objectContaining({ providerId: 'no-usable-results' }),
    );
  });
});
