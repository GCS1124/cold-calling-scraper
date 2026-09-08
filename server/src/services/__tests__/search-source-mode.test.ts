import { describe, expect, it } from 'vitest';

import {
  leadSourceModeLabels,
  leadSourceModeShortLabels,
  normalizeLeadSourceMode,
} from '../search-source-mode';

describe('search source mode contract', () => {
  it('exposes only GMB and AI modes', () => {
    expect(Object.keys(leadSourceModeLabels)).toEqual(['gmb', 'ai']);
    expect(Object.keys(leadSourceModeShortLabels)).toEqual(['gmb', 'ai']);
  });

  it('migrates retired LinkedIn payloads into AI mode', () => {
    expect(normalizeLeadSourceMode('linkedin')).toBe('ai');
  });

  it('defaults missing or unknown values to GMB', () => {
    expect(normalizeLeadSourceMode()).toBe('gmb');
    expect(normalizeLeadSourceMode('unknown')).toBe('gmb');
  });
});
