import type { Lead, LeadEvidence, LeadScores } from '../types/lead';

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

const sourceNames = (lead: Lead) =>
  lead.source
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean);

const publicSourceCount = (lead: Lead) =>
  Math.max(
    lead.matchSignals?.publicSources ?? 0,
    lead.publicEvidence?.sources?.length ?? 0,
    sourceNames(lead).length,
  );

const buildReasons = (lead: Lead, scores: Omit<LeadScores, 'reasons'>) => {
  const reasons: string[] = [];

  if (lead.matchSignals?.categoryMatched) reasons.push('Category matched');
  if (lead.matchSignals?.locationMatched) reasons.push('Location matched');
  if (lead.matchSignals?.ownerMatched) reasons.push('Owner or founder signal');
  if (lead.matchSignals?.roleMatched) reasons.push('Decision-maker role signal');
  if (lead.hasWebsite) reasons.push('Public website found');
  if (lead.verifiedPhone) reasons.push('Phone validated');
  if (lead.verifiedEmail) reasons.push('Business email validated');
  if (publicSourceCount(lead) > 1) reasons.push('Multiple public sources');
  if (scores.opportunity > 0) reasons.push('Public opportunity signal');

  return reasons.length ? reasons : ['Public result requires manual review'];
};

export const scoreLeadResearch = (lead: Lead): LeadScores => {
  const sources = publicSourceCount(lead);
  const trust = clamp(
    (lead.sourceScore ?? 50) * 0.5 +
      Math.min(30, sources * 10) +
      (lead.publicEvidence ? 10 : 0) +
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
  const opportunity = clamp((lead.opportunitySignals?.length ?? 0) * 25);
  const priority = clamp(
    trust * 0.3 + fit * 0.3 + contactability * 0.25 + opportunity * 0.15,
  );
  const scores = { trust, fit, contactability, opportunity, priority };

  return {
    ...scores,
    reasons: buildReasons(lead, scores),
  };
};

export const buildLeadEvidence = (lead: Lead): LeadEvidence[] => {
  const observedAt = lead.scrapedAt;
  const evidence: LeadEvidence[] = [];

  if (lead.listingUrl?.trim()) {
    evidence.push({
      sourceUrl: lead.listingUrl,
      sourceName: lead.source || 'Public listing',
      claim: `Public listing identifies ${lead.name}.`,
      status: 'confirmed',
      observedAt,
    });
  }

  if (lead.website?.trim()) {
    evidence.push({
      sourceUrl: lead.website,
      sourceName: 'Public website',
      claim: 'A public business website was found.',
      status: 'confirmed',
      observedAt,
    });
  }

  if (lead.contactSourceUrl?.trim() && lead.verifiedPhone) {
    evidence.push({
      sourceUrl: lead.contactSourceUrl,
      sourceName: 'Public website contact page',
      claim: 'The public business website lists the validated phone number.',
      status: 'confirmed',
      observedAt,
    });
  }

  if (lead.website?.trim()) {
    for (const signal of lead.opportunitySignals ?? []) {
      evidence.push({
        sourceUrl: lead.website,
        sourceName: 'Public website opportunity scan',
        claim: `${signal} observed on the public business website.`,
        status: 'inferred',
        observedAt,
      });
    }
  }

  return evidence;
};

export const attachLeadResearchSignals = (lead: Lead): Lead => {
  const evidence = [...(lead.evidence ?? []), ...buildLeadEvidence(lead)].filter(
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
