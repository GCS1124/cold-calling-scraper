import type { Lead, LeadEvidence, LeadScores } from '../types/lead';
import { collectContactEvidence, getContactEvidence } from './contact-evidence';
import {
  authorityTierFor,
  collectLeadSourceObservations,
  getIndependentSourceFamilies,
  getStrongestAuthorityTier,
  samePublicHost,
  sourceFamilyForEvidence,
} from './source-evidence';
import { assessOpportunitySignals } from '../../../shared/opportunity-signals';

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

const safeEvidence = (lead: Lead): LeadEvidence[] => (
  Array.isArray(lead.evidence)
    ? lead.evidence.filter((item): item is LeadEvidence => Boolean(
        item &&
          typeof item === 'object' &&
          typeof item.sourceUrl === 'string' &&
          typeof item.sourceName === 'string' &&
          typeof item.claim === 'string',
      ))
    : []
);

const sourceObservations = (lead: Lead) =>
  collectLeadSourceObservations(lead, collectContactEvidence(lead));

const buildReasons = (lead: Lead, scores: Omit<LeadScores, 'reasons'>) => {
  const reasons: string[] = [];

  if (lead.matchSignals?.categoryMatched) reasons.push('Category matched');
  if (lead.matchSignals?.locationMatched) reasons.push('Location matched');
  if (lead.matchSignals?.ownerMatched) reasons.push('Owner or founder signal');
  if (lead.matchSignals?.roleMatched) reasons.push('Decision-maker role signal');
  if (lead.hasWebsite) reasons.push('Public website found');
  if (lead.verifiedPhone) reasons.push('Phone format checked');
  if (lead.verifiedEmail) reasons.push('Business email format checked');
  if (scores.independentSourceCount > 1) {
    reasons.push(`${scores.independentSourceCount} independent source families`);
  }
  if (scores.opportunity > 0) reasons.push('Public opportunity signal');
  if (scores.opportunityTypes?.length) {
    reasons.push(`Opportunity types: ${scores.opportunityTypes.join(', ')}`);
  }
  for (const contradiction of scores.contradictionFlags ?? []) {
    reasons.push(`Review: ${contradiction}`);
  }

  return reasons.length ? reasons : ['Public result requires manual review'];
};

export const scoreLeadResearch = (lead: Lead): LeadScores => {
  const observations = sourceObservations(lead);
  const sourceFamilies = getIndependentSourceFamilies(observations);
  const sources = sourceFamilies.length;
  const strongestAuthority = getStrongestAuthorityTier(observations);
  const authorityScore = { A: 100, B: 85, C: 65, D: 30 }[strongestAuthority];
  const sourceScore = typeof lead.sourceScore === 'number' && Number.isFinite(lead.sourceScore)
    ? lead.sourceScore
    : 50;
  const trust = clamp(
    sourceScore * 0.4 +
      Math.min(30, sources * 12) +
      authorityScore * 0.2 +
      (lead.publicEvidence ? 6 : 0) +
      (lead.verifiedPhone ? 10 : 0),
  );
  const fit = clamp(
    25 +
      (lead.matchSignals?.categoryMatched ? 25 : 0) +
      (lead.matchSignals?.locationMatched ? 25 : 0) +
      (lead.matchSignals?.roleMatched ? 15 : 0) +
      (lead.matchSignals?.ownerMatched ? 10 : 0),
  );
  const contactability = clamp(
    (lead.hasPhone ? 45 : 0) +
      (lead.verifiedPhone ? 25 : 0) +
      (lead.hasEmail ? 15 : 0) +
      (lead.verifiedEmail ? 10 : 0) +
      (lead.hasWebsite ? 5 : 0),
  );
  const opportunitySignals = Array.isArray(lead.opportunitySignals)
    ? lead.opportunitySignals.filter((signal): signal is string => typeof signal === 'string')
    : [];
  const opportunityAnalysis = assessOpportunitySignals(opportunitySignals);
  const opportunity = clamp(
    opportunityAnalysis.positiveCount * 25 - opportunityAnalysis.negativeCount * 40,
  );
  const contradictionFlags = [
    ...(lead.employmentStatus === 'former' ? ['Former employment signal'] : []),
    ...(lead.employmentStatus === 'conflicting' ? ['Conflicting employment signal'] : []),
    ...(safeEvidence(lead).some((item) => item.status === 'conflicting')
      ? ['Conflicting public evidence']
      : []),
    ...(lead.websiteAssessment?.status === 'unrelated' ? ['Website identity is unrelated'] : []),
  ];
  const contradictionPenalty = Math.min(60, contradictionFlags.length * 25);
  const priority = clamp(
    trust * 0.3 + fit * 0.3 + contactability * 0.25 + opportunity * 0.15 - contradictionPenalty,
  );
  const scores = {
    trust,
    fit,
    contactability,
    opportunity,
    priority,
    independentSourceCount: sources,
    sourceFamilies,
    opportunityTypes: [
      ...new Set([
        ...opportunityAnalysis.positiveTypes,
        ...opportunityAnalysis.negativeTypes,
        ...opportunityAnalysis.assessments
          .filter((assessment) => assessment.type === 'conversion_gap')
          .map((assessment) => assessment.type),
      ]),
    ],
    contradictionFlags,
    contradictionPenalty,
  };

  return {
    ...scores,
    reasons: buildReasons(lead, scores),
  };
};

export const buildLeadEvidence = (lead: Lead): LeadEvidence[] => {
  const observedAt = lead.scrapedAt;
  const evidence: LeadEvidence[] = [];
  const listingUrl = typeof lead.listingUrl === 'string' ? lead.listingUrl.trim() : '';
  const website = typeof lead.website === 'string' ? lead.website.trim() : '';

  if (listingUrl) {
    const sourceFamily = sourceFamilyForEvidence({
      sourceUrl: listingUrl,
      sourceName: lead.source || 'Public listing',
    });
    evidence.push({
      sourceUrl: listingUrl,
      sourceName: lead.source || 'Public listing',
      sourceFamily,
      authorityTier: authorityTierFor(sourceFamily),
      claim: `Public listing identifies ${lead.name}.`,
      status: 'confirmed',
      observedAt,
    });
  }

  if (website) {
    const sourceFamily = sourceFamilyForEvidence({
      sourceUrl: website,
      sourceName: 'Public website',
      officialWebsite: ['confirmed', 'probable'].includes(lead.websiteAssessment?.status ?? ''),
    });
    evidence.push({
      sourceUrl: website,
      sourceName: 'Public website',
      sourceFamily,
      authorityTier: authorityTierFor(sourceFamily),
      claim: 'A public business website was found.',
      status: 'confirmed',
      observedAt,
    });
  }

  for (const contact of getContactEvidence(lead, 'phone')) {
    const sourceFamily = sourceFamilyForEvidence({
      sourceUrl: contact.sourceUrl,
      sourceName: contact.sourceName,
      sourceKind: contact.sourceKind,
      officialWebsite:
        ['confirmed', 'probable'].includes(lead.websiteAssessment?.status ?? '') &&
        samePublicHost(contact.sourceUrl, lead.website)
          ? true
          : undefined,
    });
    evidence.push({
      sourceUrl: contact.sourceUrl,
      sourceName: contact.sourceName,
      sourceFamily,
      authorityTier: authorityTierFor(sourceFamily),
      claim: `Public source lists phone ${contact.value}; reachability has not been checked.`,
      status: 'confirmed',
      observedAt: contact.observedAt,
    });
  }

  if (website) {
    const opportunitySignals = Array.isArray(lead.opportunitySignals)
      ? lead.opportunitySignals.filter((signal): signal is string => typeof signal === 'string')
      : [];
    for (const signal of opportunitySignals) {
      const sourceFamily = sourceFamilyForEvidence({
        sourceUrl: website,
        sourceName: 'Public website opportunity scan',
        officialWebsite: ['confirmed', 'probable'].includes(lead.websiteAssessment?.status ?? ''),
      });
      evidence.push({
        sourceUrl: website,
        sourceName: 'Public website opportunity scan',
        sourceFamily,
        authorityTier: authorityTierFor(sourceFamily),
        claim: `${signal} observed on the public business website.`,
        status: 'inferred',
        observedAt,
      });
    }
  }

  return evidence;
};

export const attachLeadResearchSignals = (lead: Lead): Lead => {
  const evidence = [...safeEvidence(lead), ...buildLeadEvidence(lead)].filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.sourceUrl === item.sourceUrl && candidate.claim === item.claim,
      ) === index,
  );

  return {
    ...lead,
    ...(evidence.length ? { evidence } : {}),
    scores: scoreLeadResearch(lead),
  };
};
