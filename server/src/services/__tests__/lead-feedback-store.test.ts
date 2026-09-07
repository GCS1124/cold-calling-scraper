import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Lead } from '../../types/lead';
import { getLeadFeedbackEntityKey, getLeadFeedbackSuppressionKeys } from '../../../../shared/lead-feedback';

const lead: Lead = {
  id: 'feedback-lead',
  name: 'North Star HVAC',
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

describe('lead feedback store', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps suppression entries isolated by owner and idempotent by event', async () => {
    const { createLeadFeedbackStore } = await import('../lead-feedback-store');
    const store = createLeadFeedbackStore();
    const input = {
      searchId: 'feedback-search',
      ownerId: 'owner-a',
      leadId: lead.id,
      eventType: 'wrong_phone' as const,
      entityKey: getLeadFeedbackEntityKey(lead, 'wrong_phone'),
      suppressionKeys: getLeadFeedbackSuppressionKeys(lead, 'wrong_phone'),
    };

    await expect(store.getSuppressionKeys('owner-a')).resolves.toEqual(new Set());
    await expect(store.recordFeedback(input)).resolves.toEqual({ created: true });
    await expect(store.recordFeedback(input)).resolves.toEqual({ created: false });
    await expect(store.getSuppressionKeys('owner-a')).resolves.toEqual(
      new Set([
        'phone-association:phone:5125550100|organization:north star hvac|austin|tx|northstar-hvac.example',
      ]),
    );
    await expect(store.getSuppressionKeys('owner-b')).resolves.toEqual(new Set());
  });
});
