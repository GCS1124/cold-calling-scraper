import { describe, expect, it } from 'vitest';

import {
  assessOpportunitySignal,
  assessOpportunitySignals,
} from '../opportunity-signals';

describe('opportunity signal taxonomy', () => {
  it('treats hiring, growth, and active-service wording as positive signals', () => {
    expect(assessOpportunitySignals([
      'Public hiring signal',
      'Public growth signal',
      'Public active-service CTA',
    ])).toMatchObject({
      positiveTypes: ['hiring', 'growth_or_expansion', 'active_service'],
      positiveCount: 3,
      negativeCount: 0,
    });
  });

  it('does not treat an absent booking link as demand evidence', () => {
    expect(assessOpportunitySignal('No online booking link observed')).toEqual({
      type: 'conversion_gap',
      polarity: 'neutral',
    });
  });

  it('penalizes explicit closure wording instead of rewarding it', () => {
    expect(assessOpportunitySignal('Permanently closed')).toEqual({
      type: 'negative_status',
      polarity: 'negative',
    });
  });

  it('deduplicates repeated signal types', () => {
    expect(assessOpportunitySignals(['Public hiring signal', 'Public hiring signal']).positiveCount).toBe(1);
  });
});
