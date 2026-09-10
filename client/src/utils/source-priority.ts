import type { Lead, ProviderCoverage } from '../types/lead';

export type PublicSourcePriority = 1 | 2 | 3 | 4;

const notaryCafeSourcePattern = /\bnotary\s*cafe\b/i;
const linkedInSourcePattern = /\blinkedIn\b/i;
const googleBusinessSourcePattern = /\bgoogle\s*(?:places|business|maps)\b/i;

const getLeadUrls = (lead: Lead) =>
  [lead.listingUrl, lead.contactSourceUrl, lead.decisionMakerSourceUrl, lead.website].filter(
    (value): value is string => typeof value === 'string' && Boolean(value.trim()),
  );

const hasNotaryCafeEvidence = (lead: Lead) => {
  const source = typeof lead.source === 'string' ? lead.source : '';
  return (
    notaryCafeSourcePattern.test(source) ||
    getLeadUrls(lead).some((url) => /(?:^|\/\/)(?:www\.)?notarycafe\.com\//i.test(url))
  );
};

const hasLinkedInEvidence = (lead: Lead) => {
  const source = typeof lead.source === 'string' ? lead.source : '';
  return (
    linkedInSourcePattern.test(source) ||
    getLeadUrls(lead).some((url) => /(?:^|\/\/)(?:www\.)?linkedin\.com\/(?:in|pub)\//i.test(url))
  );
};

const hasGoogleBusinessEvidence = (lead: Lead) => {
  const source = typeof lead.source === 'string' ? lead.source : '';
  return (
    googleBusinessSourcePattern.test(source) ||
    getLeadUrls(lead).some((url) => /(?:google\.[^/]+\/maps\b|maps\.google\.)/i.test(url))
  );
};

export const isNotaryRelatedCategory = (value: unknown) =>
  typeof value === 'string' &&
  /\bnotar(?:y|ies)\b|\b(?:mobile|loan|signing|remote online|apostille)\s+notar(?:y|ies)\b|\bsigning\s+agent\b/i.test(
    value.trim(),
  );

/**
 * The AI workflow makes provenance stable and visible:
 * indexed NotaryCafe evidence, pure public LinkedIn evidence, then LinkedIn
 * plus Google Business fusion, followed by every other public source.
 * Eligibility still comes from the server's public-phone and evidence gates.
 */
export const getPublicSourcePriority = (lead: Lead): PublicSourcePriority => {
  if (hasNotaryCafeEvidence(lead)) return 1;

  const hasLinkedIn = hasLinkedInEvidence(lead);
  const hasGoogleBusiness = hasGoogleBusinessEvidence(lead);
  if (hasLinkedIn && hasGoogleBusiness) return 3;
  if (hasLinkedIn) return 2;
  return 4;
};

export const comparePublicSourcePriority = (left: Lead, right: Lead) =>
  getPublicSourcePriority(left) - getPublicSourcePriority(right);

export const publicSourcePriorityLabels: Record<PublicSourcePriority, string> = {
  1: 'NotaryCafe indexed evidence',
  2: 'Pure public LinkedIn evidence',
  3: 'LinkedIn + Google Business fusion',
  4: 'Other public evidence',
};

const getCoveragePriority = (provider: ProviderCoverage) => {
  const providerId = provider.providerId.toLowerCase();
  const providerName = provider.providerName.toLowerCase();

  if (providerId.includes('notarycafe') || providerName.includes('notarycafe')) return 1;
  if (providerId.includes('linkedin-public') || providerName.includes('public linkedin')) return 2;
  if (
    providerId.includes('google-places') ||
    providerId.includes('public-business-listings') ||
    providerName.includes('google business') ||
    providerName.includes('public business listings')
  ) {
    return 3;
  }
  if (providerId.includes('public-website') || providerName.includes('public website')) return 4;
  if (providerId.includes('gemini') || providerName.includes('gemini')) return 5;
  return 6;
};

export const sortProviderCoverageForDisplay = (coverage: ProviderCoverage[]) =>
  coverage
    .map((provider, index) => ({ provider, index, priority: getCoveragePriority(provider) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ provider }) => provider);
