import { parsePhoneNumberFromString } from 'libphonenumber-js';

import type { ContactEvidence } from '../../../shared/lead-quality';
import type { Lead } from '../types/lead';
import { isPublicHttpUrl } from '../utils/public-url';

export const normalizeContactPhone = (value?: string) => {
  if (typeof value !== 'string') return '';
  const phone = parsePhoneNumberFromString(value ?? '', 'US');
  return phone?.isValid() && phone.country === 'US'
    ? `${phone.number}${phone.ext ? ` ext. ${phone.ext}` : ''}`
    : '';
};

export const isPublicContactSource = (value?: string) => {
  if (typeof value !== 'string' || !value || !isPublicHttpUrl(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && url.hostname.includes('.');
};

export const isProfessionalProfile = (value?: string) => {
  if (!isPublicContactSource(value)) return false;
  const url = new URL(value!);
  return /(?:^|\.)linkedin\.com$/i.test(url.hostname) && /^\/(?:in|pub)\//i.test(url.pathname);
};

const isBusinessListing = (value?: string) => {
  if (!isPublicContactSource(value)) return false;
  const url = new URL(value!);
  return (
    (/(?:^|\.)google\.com$/i.test(url.hostname) &&
      (url.pathname.startsWith('/maps') || url.hostname === 'maps.google.com')) ||
    (/(?:^|\.)openstreetmap\.org$/i.test(url.hostname) && /^\/(node|way|relation)\//.test(url.pathname))
  );
};

const normalizeValue = (field: ContactEvidence['field'], value?: string) =>
  field === 'phone' ? normalizeContactPhone(value) : typeof value === 'string' ? value.trim().toLowerCase() : '';

export const createContactEvidence = (
  observation: ContactEvidence,
): ContactEvidence | undefined => {
  if (!observation || !['phone', 'email'].includes(observation.field) ||
    !['business_listing', 'business_website', 'public_snippet'].includes(observation.sourceKind) ||
    !['business', 'person', 'unknown'].includes(observation.association) ||
    typeof observation.sourceName !== 'string') return undefined;
  const value = normalizeValue(observation.field, observation.value);
  if (!value || !isPublicContactSource(observation.sourceUrl)) return undefined;
  return { ...observation, value };
};

export const mergeContactEvidence = (observations: ContactEvidence[]): ContactEvidence[] => {
  if (!Array.isArray(observations)) return [];
  const unique = new Map<string, ContactEvidence>();
  for (const item of observations) {
    const observation = createContactEvidence(item);
    if (!observation) continue;
    const key = [observation.field, observation.value, observation.sourceUrl, observation.sourceKind].join('|');
    const previous = unique.get(key);
    const previousTime = Date.parse(previous?.observedAt ?? '');
    const nextTime = Date.parse(observation.observedAt ?? '');
    if (!previous || (Number.isFinite(nextTime) && (!Number.isFinite(previousTime) || nextTime > previousTime))) {
      unique.set(key, observation);
    }
  }
  return [...unique.values()];
};

/** Legacy records keep only the contact provenance the old shape can actually establish. */
export const collectContactEvidence = (lead: Lead): ContactEvidence[] => {
  if (lead.contactEvidence !== undefined) return mergeContactEvidence(lead.contactEvidence);

  const observations: ContactEvidence[] = [];
  const phone = normalizeContactPhone(lead.mobile);
  const legacySource = isPublicContactSource(lead.contactSourceUrl)
    ? lead.contactSourceUrl
    : isBusinessListing(lead.listingUrl)
      ? lead.listingUrl
      : undefined;

  if (phone && legacySource && !isProfessionalProfile(legacySource)) {
    observations.push({
      field: 'phone', value: phone, sourceUrl: legacySource,
      sourceName: isBusinessListing(legacySource) ? lead.source : 'Public business contact source',
      sourceKind: isBusinessListing(legacySource) ? 'business_listing' : 'business_website',
      observedAt: lead.scrapedAt, association: 'business',
    });
  }

  for (const evidence of lead.evidence ?? []) {
    if (!['confirmed', 'corroborated'].includes(evidence.status) ||
      !isPublicContactSource(evidence.sourceUrl) || isProfessionalProfile(evidence.sourceUrl)) continue;
    // A listing-identity claim or a rejected phone claim is not contact evidence.
    if (phone && /\b(phone|telephone)\b/i.test(evidence.claim) &&
      !/\b(no|not|unverified|invalid|missing|unconfirmed)\b/i.test(evidence.claim)) {
      const statedNumber = evidence.claim.match(/\+?\d[\d\s().-]{8,}\d/)?.[0];
      if (statedNumber && normalizeContactPhone(statedNumber) !== phone) continue;
      observations.push({
        field: 'phone', value: phone, sourceUrl: evidence.sourceUrl,
        sourceName: evidence.sourceName,
        sourceKind: isBusinessListing(evidence.sourceUrl) ? 'business_listing' : 'business_website',
        observedAt: evidence.observedAt ?? lead.scrapedAt, association: 'business',
      });
    }
  }
  return mergeContactEvidence(observations);
};

export const getContactEvidence = (lead: Lead, field: ContactEvidence['field']) => {
  const value = normalizeValue(field, field === 'phone' ? lead.mobile : lead.email);
  if (!value) return [];
  return collectContactEvidence(lead).filter((item) => item.field === field && item.value === value);
};
