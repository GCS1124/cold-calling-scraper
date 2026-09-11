/**
 * Stable public-source ordering shared by the server and the React client.
 *
 * Provider names are not the only place provenance can live. A merged lead can
 * carry a LinkedIn profile in `listingUrl`, a Google Maps contact observation,
 * and provider names inside public evidence or match signals. Reading all of
 * those bounded, public fields keeps the display tier correct after merging and
 * deduplication without treating model prose as proof.
 */

export type PublicSourcePriority = 1 | 2 | 3 | 4;

type SourcePriorityEntry = {
  providerName?: unknown;
  sourceName?: unknown;
  sourceUrl?: unknown;
  url?: unknown;
  platform?: unknown;
};

export type SourcePriorityLead = {
  source?: unknown;
  listingUrl?: unknown;
  contactSourceUrl?: unknown;
  decisionMakerSourceUrl?: unknown;
  website?: unknown;
  publicEvidence?: {
    sources?: unknown;
  };
  evidence?: unknown;
  contactEvidence?: unknown;
  publicSocialLinks?: unknown;
  matchSignals?: {
    publicProviderNames?: unknown;
  };
};

export type SourcePriorityProvider = {
  providerId: string;
  providerName: string;
};

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const readEntries = (value: unknown): SourcePriorityEntry[] => {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (entry): entry is SourcePriorityEntry => Boolean(entry && typeof entry === 'object'),
  );
};

const readEntryText = (entry: SourcePriorityEntry, ...keys: Array<keyof SourcePriorityEntry>) =>
  keys.map((key) => asText(entry[key])).find(Boolean) ?? '';

const normalizeSourceLabel = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

const linkedInSourcePattern = /\blink(?:ed\s*-?in)\b/i;
const googleBusinessSourcePattern = /\b(?:google\s*(?:places|business|maps)|gmb)\b/i;
const notaryCafeSourcePattern = /\bnotary\s*cafe\b/i;
const linkedInProfileUrlPattern = /(?:^|\/\/)(?:www\.)?linkedin\.com\/(?:in|pub)\//i;
const googleMapsUrlPattern = /(?:google\.[^/]+\/maps\b|maps\.google\.)/i;
const notaryCafeUrlPattern = /(?:^|\/\/)(?:www\.)?notarycafe\.com(?:\/|$)/i;

const getLeadSourceLabels = (lead: SourcePriorityLead) => [
  asText(lead.source),
  ...readEntries(lead.publicEvidence?.sources).map((entry) =>
    readEntryText(entry, 'providerName', 'sourceName'),
  ),
  ...readEntries(lead.evidence).map((entry) => readEntryText(entry, 'sourceName', 'providerName')),
  ...readEntries(lead.contactEvidence).map((entry) =>
    readEntryText(entry, 'sourceName', 'providerName'),
  ),
  ...readEntries(lead.publicSocialLinks).map((entry) =>
    readEntryText(entry, 'platform', 'providerName', 'sourceName'),
  ),
  ...(Array.isArray(lead.matchSignals?.publicProviderNames)
    ? lead.matchSignals.publicProviderNames.map(asText)
    : []),
].filter(Boolean);

const getLeadSourceUrls = (lead: SourcePriorityLead) => [
  lead.listingUrl,
  lead.contactSourceUrl,
  lead.decisionMakerSourceUrl,
  lead.website,
  ...readEntries(lead.evidence).map((entry) => entry.sourceUrl ?? entry.url),
  ...readEntries(lead.contactEvidence).map((entry) => entry.sourceUrl ?? entry.url),
  ...readEntries(lead.publicSocialLinks).map((entry) => entry.url ?? entry.sourceUrl),
].map(asText).filter(Boolean);

const hasSourceLabel = (labels: string[], pattern: RegExp) =>
  labels.some((label) => pattern.test(label));

const hasSourceUrl = (urls: string[], pattern: RegExp) =>
  urls.some((url) => pattern.test(url));

export const getPublicLeadSourcePriority = (lead: SourcePriorityLead): PublicSourcePriority => {
  const labels = getLeadSourceLabels(lead);
  const urls = getLeadSourceUrls(lead);

  if (
    hasSourceLabel(labels, notaryCafeSourcePattern) ||
    hasSourceUrl(urls, notaryCafeUrlPattern)
  ) {
    return 1;
  }

  const hasLinkedIn =
    hasSourceLabel(labels, linkedInSourcePattern) || hasSourceUrl(urls, linkedInProfileUrlPattern);
  const hasGoogleBusiness =
    hasSourceLabel(labels, googleBusinessSourcePattern) || hasSourceUrl(urls, googleMapsUrlPattern);

  // Fusion is intentionally the final lead tier. A corroborated LinkedIn +
  // Google Business record should not outrank an independently discovered
  // generic public source merely because it has two source families.
  if (hasLinkedIn && hasGoogleBusiness) return 4;
  if (hasLinkedIn) return 2;
  return 3;
};

export const getPublicProviderPriority = (
  provider: SourcePriorityProvider,
) => {
  const providerId = normalizeSourceLabel(provider.providerId);
  const providerName = normalizeSourceLabel(provider.providerName);
  const providerText = `${providerId} ${providerName}`;
  const hasLinkedIn = linkedInSourcePattern.test(providerText);
  const hasGoogleBusiness = googleBusinessSourcePattern.test(providerText);

  // A dedicated fusion card must remain the final public-source card, even
  // when its id happens to begin with `linkedin-public`.
  if (hasLinkedIn && hasGoogleBusiness) return 4;
  if (providerId.includes('notarycafe') || providerName.includes('notarycafe')) return 1;
  if (providerId.includes('linkedin-public') || providerName.includes('public linkedin')) return 2;
  if (
    providerId.includes('google-places') ||
    providerId.includes('public-business-listings') ||
    providerId.includes('public-website') ||
    providerId.endsWith('-public-directory') ||
    providerId.includes('gemini') ||
    providerName.includes('google business') ||
    providerName.includes('public business listings') ||
    providerName.includes('public website') ||
    providerName.includes('public directory') ||
    providerName.includes('openstreetmap') ||
    providerName.includes('osm') ||
    providerName.includes('gemini')
  ) {
    return 3;
  }
  return 5;
};
