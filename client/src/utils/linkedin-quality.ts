import type { Lead } from '../types/lead';

export function isHighFitLinkedInLead(lead: Lead) {
  const signals = lead.matchSignals;

  return Boolean(
    lead.confidence >= 85 &&
      signals?.locationMatched &&
      signals.categoryMatched !== false &&
      (signals.roleMatched || signals.publicSources >= 2),
  );
}
