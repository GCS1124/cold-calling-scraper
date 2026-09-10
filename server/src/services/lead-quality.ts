import type { LeadQualityAssessment } from '../../../shared/lead-quality';
import type { Lead } from '../types/lead';
import {
  collectContactEvidence,
  getContactEvidence,
  isProfessionalProfile,
  normalizeContactPhone,
} from './contact-evidence';
import {
  collectLeadSourceObservations,
  getIndependentSourceFamilies,
} from './source-evidence';

const freshnessWindowMs = 30 * 24 * 60 * 60 * 1_000;

export const assessLeadQuality = (lead: Lead, now = Date.now()): LeadQualityAssessment => {
  const allContactEvidence = collectContactEvidence(lead);
  const phoneEvidence = allContactEvidence.filter((item) => item.field === 'phone');
  const emailEvidence = getContactEvidence(lead, 'email');
  const sourceFamilies = getIndependentSourceFamilies(
    collectLeadSourceObservations(lead, allContactEvidence),
  );
  const formatValid = Boolean(normalizeContactPhone(lead.mobile));
  const phoneQualified = formatValid && lead.hasPhone && lead.verifiedPhone && phoneEvidence.length > 0;
  const sourceKinds = [...new Set(phoneEvidence.map((item) => item.sourceKind))];
  const observations = phoneEvidence.map((item) => Date.parse(item.observedAt ?? ''))
    .filter((date) => Number.isFinite(date) && date <= now + 300_000);
  const lastObserved = observations.length ? Math.max(...observations) : undefined;
  const freshness = lastObserved === undefined ? 'unknown'
    : now - lastObserved <= freshnessWindowMs ? 'recent' : 'stale';
  const person = isProfessionalProfile(lead.listingUrl);
  const conflict = lead.employmentStatus === 'conflicting' ||
    (Array.isArray(lead.evidence) ? lead.evidence : []).some((item) =>
      Boolean(item && typeof item === 'object' && item.status === 'conflicting'),
    );
  const former = person && lead.employmentStatus === 'former';
  const reasons: string[] = [];
  const gaps: string[] = [];

  if (phoneQualified) reasons.push('Valid US phone with public source evidence');
  else gaps.push('A valid phone with public source evidence is required');
  if (phoneEvidence.some((item) => item.association === 'business') && person) {
    gaps.push('Business contact route; direct contact for this person is unconfirmed');
  }
  if (freshness === 'recent') reasons.push('Phone observed within 30 days');
  else gaps.push(freshness === 'stale' ? 'Phone source needs a fresh check' : 'Phone observation date is unknown');
  if (lead.matchSignals?.categoryMatched) reasons.push('Category match has a public signal');
  if (lead.matchSignals?.locationMatched) reasons.push('Location match has a public signal');
  if (conflict) gaps.push('Conflicting evidence requires review');
  if (former) gaps.push('Former employment does not establish a current decision-maker');
  if (person && !['current', 'probable'].includes(lead.employmentStatus ?? '')) {
    gaps.push('Current employment is unconfirmed');
  }
  const recentEvidence = phoneEvidence.filter((item) => {
    const age = now - Date.parse(item.observedAt ?? '');
    return age >= -300_000 && age <= freshnessWindowMs;
  });
  const corroborated = recentEvidence.some((listing) => listing.sourceKind === 'business_listing' &&
    recentEvidence.some((website) => website.sourceKind === 'business_website' &&
      new URL(website.sourceUrl).hostname.replace(/^www\./, '') !== new URL(listing.sourceUrl).hostname.replace(/^www\./, '')));
  if (corroborated) reasons.push('Same phone observed on a website and business listing');
  else if (phoneQualified) gaps.push('Phone lacks website and listing corroboration');
  if (emailEvidence.length) reasons.push('Email has an explicit public source');
  if (lead.email && !emailEvidence.length) gaps.push('Email source needs review');

  const tier = !phoneQualified ? 'excluded'
    : conflict || former || freshness !== 'recent' || (person && !['current', 'probable'].includes(lead.employmentStatus ?? '')) ? 'review'
      : corroborated && (!person || ['current', 'probable'].includes(lead.employmentStatus ?? ''))
        ? 'corroborated' : 'supported';
  // This is a documented prioritization rubric, not a calibrated accuracy probability.
  const score = phoneQualified ? Math.max(0, Math.min(100,
    40 + (freshness === 'recent' ? 20 : 0) + (corroborated ? 20 : 0) +
    (emailEvidence.length ? 10 : 0) + (lead.matchSignals?.categoryMatched ? 5 : 0) +
    (lead.matchSignals?.locationMatched ? 5 : 0) - (conflict || former ? 30 : 0),
  )) : 0;

  return {
    version: 1, tier, score, reasons, gaps, sourceKinds, freshness,
    independentSourceCount: sourceFamilies.length,
    sourceFamilies,
    ...(lastObserved !== undefined ? { lastObservedAt: new Date(lastObserved).toISOString() } : {}),
    nextAction: !phoneQualified ? 'Find a public business phone source'
      : conflict || former ? 'Resolve the conflicting company or role evidence'
        : freshness !== 'recent' ? 'Revisit the phone source before outreach'
          : person ? 'Confirm the current role and ask for the person through the business'
            : 'Review the business and phone source before outreach',
    phone: {
      assessedValue: typeof lead.mobile === 'string' ? lead.mobile.trim() : '',
      formatValid, publiclyObserved: phoneEvidence.length > 0,
      association: phoneEvidence.some((item) => item.association === 'person') ? 'person'
        : phoneEvidence.some((item) => item.association === 'business') ? 'business' : 'unknown',
      sourceUrls: [...new Set(phoneEvidence.map((item) => item.sourceUrl))],
      lineType: 'unknown', reachability: 'not_checked',
    },
    email: {
      formatValid: Boolean(lead.hasEmail && lead.email), publiclyObserved: emailEvidence.length > 0,
      sourceUrls: [...new Set(emailEvidence.map((item) => item.sourceUrl))], mailbox: 'not_checked',
    },
  };
};

export const withLeadQuality = (lead: Lead): Lead => ({ ...lead, quality: assessLeadQuality(lead) });

export const rankQualifiedLeads = (leads: Lead[]): Lead[] => {
  const tierOrder = { corroborated: 3, supported: 2, review: 1, excluded: 0 };
  return leads.map(withLeadQuality).sort((left, right) =>
    tierOrder[right.quality!.tier] - tierOrder[left.quality!.tier] ||
    right.quality!.score - left.quality!.score || right.confidence - left.confidence ||
    (right.scores?.priority ?? 0) - (left.scores?.priority ?? 0) ||
    (right.scores?.opportunity ?? 0) - (left.scores?.opportunity ?? 0) ||
    left.name.localeCompare(right.name),
  );
};
