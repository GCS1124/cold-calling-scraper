import type { DecisionMakerPhonePair } from '../../../shared/lead-quality';
import type { Lead } from '../types/lead';
import {
  getContactEvidence,
  isPublicContactSource,
  normalizeContactPhone,
} from './contact-evidence';

const publicPersonSource = (value?: string) => {
  if (!isPublicContactSource(value)) return '';
  return value!.trim();
};

/**
 * Select the safest public phone route for a lead. Business evidence wins
 * over person/unknown evidence because a company phone is an outreach route,
 * not proof of a private or direct number.
 */
export const buildDecisionMakerPhonePair = (lead: Lead): DecisionMakerPhonePair => {
  const phoneEvidence = getContactEvidence(lead, 'phone')
    .filter((item) => Boolean(normalizeContactPhone(item.value)))
    .sort((left, right) => {
      const associationRank = { business: 0, unknown: 1, person: 2 } as const;
      return associationRank[left.association] - associationRank[right.association];
    });
  const selectedPhone = phoneEvidence[0];
  const personSourceUrl = publicPersonSource(lead.decisionMakerSourceUrl);
  const hasPublicDecisionMaker = Boolean(
    typeof lead.decisionMakerName === 'string' &&
      lead.decisionMakerName.trim() &&
      personSourceUrl,
  );
  const hasPublicPhone = Boolean(selectedPhone);

  return {
    status: hasPublicDecisionMaker && hasPublicPhone
      ? 'paired'
      : hasPublicDecisionMaker
        ? 'decision_maker_only'
        : hasPublicPhone
          ? 'phone_only'
          : 'unpaired',
    phoneAssociation: selectedPhone?.association ?? 'unknown',
    ...(selectedPhone?.sourceUrl ? { phoneSourceUrl: selectedPhone.sourceUrl } : {}),
    ...(selectedPhone?.sourceName ? { phoneSourceName: selectedPhone.sourceName } : {}),
    ...(personSourceUrl ? { personSourceUrl } : {}),
  };
};
