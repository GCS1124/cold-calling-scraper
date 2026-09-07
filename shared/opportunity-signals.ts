export const opportunitySignalTypes = [
  'hiring',
  'growth_or_expansion',
  'active_service',
  'conversion_gap',
  'negative_status',
  'unknown',
] as const;

export type OpportunitySignalType = (typeof opportunitySignalTypes)[number];

export type OpportunitySignalAssessment = {
  type: OpportunitySignalType;
  polarity: 'positive' | 'neutral' | 'negative';
};

const positivePatterns: Array<[RegExp, OpportunitySignalType]> = [
  [/\b(public hiring signal|now hiring|we(?:'re| are) hiring|join our team|careers?|job openings?)\b/i, 'hiring'],
  [/\b(public growth signal|expanding|expansion|new location|grand opening|now serving|new office)\b/i, 'growth_or_expansion'],
  [/\b(public active-service cta|request (?:a|an) quote|free estimate|book (?:now|today)|schedule (?:a|an)? appointment)\b/i, 'active_service'],
];

const conversionGapPattern = /\b(?:no|without|not observed|not available)\b.{0,32}\b(?:online )?booking(?: link| option)?\b/i;
const negativeStatusPattern = /\b(?:permanently closed|closed for good|out of business|no longer serving|ceased operations)\b/i;

export const assessOpportunitySignal = (signal: string): OpportunitySignalAssessment => {
  const normalized = signal.trim();

  for (const [pattern, type] of positivePatterns) {
    if (pattern.test(normalized)) {
      return { type, polarity: 'positive' };
    }
  }

  if (negativeStatusPattern.test(normalized)) {
    return { type: 'negative_status', polarity: 'negative' };
  }

  if (conversionGapPattern.test(normalized) || /\bno online booking link observed\b/i.test(normalized)) {
    return { type: 'conversion_gap', polarity: 'neutral' };
  }

  return { type: 'unknown', polarity: 'neutral' };
};

export const assessOpportunitySignals = (signals: string[]) => {
  const uniqueSignals = [...new Set(signals.map((signal) => signal.trim()).filter(Boolean))];
  const assessments = uniqueSignals.map(assessOpportunitySignal);
  const positiveTypes = [...new Set(
    assessments
      .filter((assessment) => assessment.polarity === 'positive')
      .map((assessment) => assessment.type),
  )];
  const negativeTypes = [...new Set(
    assessments
      .filter((assessment) => assessment.polarity === 'negative')
      .map((assessment) => assessment.type),
  )];

  return {
    assessments,
    positiveTypes,
    negativeTypes,
    positiveCount: positiveTypes.length,
    negativeCount: negativeTypes.length,
  };
};
