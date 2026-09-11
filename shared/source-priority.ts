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
export type PublicLeadSourceOrder = 1 | 2 | 3 | 4 | 5 | 6 | 7;

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
const yelpSourcePattern = /\byelp\b/i;
const yellowPagesSourcePattern = /\b(?:yellow\s*pages|yellowpages|yp\.com)\b/i;
const geminiSourcePattern = /\bgemini\b/i;
const linkedInProfileUrlPattern = /(?:^|\/\/)(?:www\.)?linkedin\.com\/(?:in|pub)\//i;
const googleMapsUrlPattern = /(?:google\.[^/]+\/maps\b|maps\.google\.)/i;
const notaryCafeUrlPattern = /(?:^|\/\/)(?:www\.)?notarycafe\.com(?:\/|$)/i;
const yelpUrlPattern = /(?:^|\/\/)(?:www\.)?yelp\.com(?:\/|$)/i;
const yellowPagesUrlPattern = /(?:^|\/\/)(?:www\.)?(?:yellowpages\.com|yp\.com)(?:\/|$)/i;

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

export const getPublicLeadSourceOrder = (lead: SourcePriorityLead): PublicLeadSourceOrder => {
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

  const hasYelp =
    hasSourceLabel(labels, yelpSourcePattern) || hasSourceUrl(urls, yelpUrlPattern);
  const hasYellowPages =
    hasSourceLabel(labels, yellowPagesSourcePattern) ||
    hasSourceUrl(urls, yellowPagesUrlPattern);
  const hasGemini = hasSourceLabel(labels, geminiSourcePattern);

  // Fusion is intentionally the final lead stage. A corroborated LinkedIn +
  // Google Business record must not outrank any earlier public-source path.
  if (hasLinkedIn && hasGoogleBusiness) return 7;

  // "Pure LinkedIn" means no named downstream source was merged into the
  // record. LinkedIn + Yelp/Yellow/Gemini remains in the corroborating source
  // path instead of being mislabeled as pure profile evidence.
  if (hasLinkedIn && !hasYelp && !hasYellowPages && !hasGemini && !hasGoogleBusiness) {
    return 2;
  }

  if (hasYelp) return 3;
  if (hasYellowPages) return 4;
  if (hasGemini) return 5;
  if (hasGoogleBusiness) return 6;

  // OSM, public websites, and other bounded public fallbacks share the
  // generic research slot. They remain before Google Places and fusion.
  return 5;
};

export const getPublicLeadSourcePriority = (lead: SourcePriorityLead): PublicSourcePriority => {
  const order = getPublicLeadSourceOrder(lead);

  if (order === 1) return 1;
  if (order === 2) return 2;
  if (order === 7) return 4;
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
  const hasYelp = yelpSourcePattern.test(providerText);
  const hasYellowPages = yellowPagesSourcePattern.test(providerText);
  const hasGemini = geminiSourcePattern.test(providerText);

  if (providerId.includes('notarycafe') || providerName.includes('notarycafe')) return 1;
  // A dedicated fusion card must remain final, even when its id happens to
  // begin with `linkedin-public`.
  if (hasLinkedIn && hasGoogleBusiness) return 7;
  if (providerId.includes('linkedin-public') || providerName.includes('public linkedin')) return 2;
  if (hasYelp) return 3;
  if (hasYellowPages) return 4;
  if (hasGemini) return 5;
  if (providerId.includes('google-places') || providerId.includes('google-maps') || hasGoogleBusiness) {
    return 6;
  }
  if (
    providerId.includes('public-business-listings') ||
    providerId.includes('public-website') ||
    providerId.endsWith('-public-directory') ||
    providerName.includes('public business listings') ||
    providerName.includes('public website') ||
    providerName.includes('public directory') ||
    providerName.includes('openstreetmap') ||
    providerName.includes('osm')
  ) {
    // Keep unlisted generic fallbacks after the dedicated Gemini stage while
    // still before Google Places. This is a provider-sort key, not a user
    // visible stage number.
    return 5.5;
  }
  return 8;
};
