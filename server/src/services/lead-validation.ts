import { parsePhoneNumberFromString } from 'libphonenumber-js';

import type { Lead } from '../types/lead';

export type LeadQualityLevel = 'excellent' | 'good' | 'fair' | 'weak' | 'rejected';

const emailPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const freeEmailDomains = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'aol.com',
  'live.com',
  'msn.com',
  'proton.me',
  'protonmail.com',
  'mail.com',
]);

const badEmailDomains = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'test.com',
  'localhost.com',
  'yourdomain.com',
  'email.com',
]);

const badEmailPrefixes = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'example',
  'test',
  'user',
  'name',
]);

const blockedRejectionReasons = new Set([
  'blocked_website',
  'blocked_google',
]);

const normalizeEmail = (value?: string) => {
  const trimmed = value?.trim().toLowerCase() ?? '';

  if (!trimmed) {
    return '';
  }

  return trimmed.replace(/^mailto:/i, '').split('?')[0].trim();
};

const isValidEmail = (value: string) => {
  if (!emailPattern.test(value)) {
    return false;
  }

  const [localPart = '', domain = ''] = value.toLowerCase().split('@');

  if (!localPart || !domain) {
    return false;
  }

  if (badEmailDomains.has(domain)) {
    return false;
  }

  if (badEmailPrefixes.has(localPart)) {
    return false;
  }

  const labels = domain.split('.').filter(Boolean);

  if (labels.length < 2) {
    return false;
  }

  const topLevelLabel = labels[labels.length - 1] ?? '';

  if (topLevelLabel.length < 2 || topLevelLabel.length > 24) {
    return false;
  }

  return labels.every(
    (label) =>
      /^[a-z0-9-]+$/i.test(label) &&
      label.length <= 63 &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
};

const isLikelyBusinessEmail = (value: string) => {
  if (!isValidEmail(value)) {
    return false;
  }

  const [, domain = ''] = value.toLowerCase().split('@');

  return !freeEmailDomains.has(domain);
};

const normalizeWebsite = (value?: string) => {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    return '';
  }

  if (/^(mailto|tel|sms|javascript|data):/i.test(trimmed)) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);

    if (!/^https?:$/i.test(url.protocol)) {
      return '';
    }

    url.hash = '';

    return url.toString();
  } catch {
    return '';
  }
};

const normalizeUsPhone = (value?: string) => {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    return '';
  }

  const parsed = parsePhoneNumberFromString(trimmed, 'US');

  if (!parsed?.isValid() || parsed.country !== 'US') {
    return trimmed;
  }

  return parsed.formatInternational().replace(/-/g, ' ');
};

const isValidUsPhone = (value?: string) => {
  const parsed = parsePhoneNumberFromString(value ?? '', 'US');

  return Boolean(parsed?.isValid() && parsed.country === 'US');
};

const normalizeSource = (source?: string) => {
  return [
    ...new Set(
      (source ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ].join(', ');
};

const hasSource = (lead: Lead, sourceName: string) => {
  return normalizeSource(lead.source)
    .toLowerCase()
    .split(',')
    .map((source) => source.trim())
    .includes(sourceName.toLowerCase());
};

const hasUsefulAddress = (address?: string) => {
  const trimmed = address?.trim() ?? '';

  return trimmed.length >= 8;
};

const getSourceScore = (lead: Lead) => {
  if (typeof lead.sourceScore === 'number') {
    return lead.sourceScore;
  }

  if (hasSource(lead, 'Google Places') || hasSource(lead, 'Google Maps')) {
    return 90;
  }

  if (hasSource(lead, 'Website Crawl')) {
    return 75;
  }

  if (hasSource(lead, 'OpenStreetMap')) {
    return 65;
  }

  return 50;
};

const getQualityLevel = (lead: Lead): LeadQualityLevel => {
  if (lead.rejectionReason) {
    return 'rejected';
  }

  if (lead.hasEmail && lead.hasPhone && lead.hasWebsite) {
    return lead.verifiedEmail && lead.verifiedPhone ? 'excellent' : 'good';
  }

  if ((lead.hasEmail && lead.hasPhone) || (lead.hasPhone && lead.hasWebsite)) {
    return 'good';
  }

  if (lead.hasPhone || lead.hasEmail || lead.hasWebsite) {
    return 'fair';
  }

  return 'weak';
};

const scoreLead = (lead: Lead) => {
  let score = 30;

  if (lead.hasEmail) score += 14;
  if (lead.hasPhone) score += 18;
  if (lead.hasWebsite) score += 14;
  if (hasUsefulAddress(lead.address)) score += 6;

  if (lead.verifiedEmail) score += 8;
  if (lead.verifiedPhone) score += 10;

  if (hasSource(lead, 'Google Places')) score += 12;
  if (hasSource(lead, 'Google Maps')) score += 12;
  if (hasSource(lead, 'Website Crawl')) score += 8;
  if (hasSource(lead, 'OpenStreetMap')) score += 5;

  if (lead.hasPhone && lead.hasWebsite) score += 8;
  if (lead.hasEmail && lead.hasWebsite) score += 5;
  if (lead.hasEmail && lead.hasPhone) score += 8;

  if (lead.rejectionReason) score -= 35;

  const sourceScore = getSourceScore(lead);
  score = Math.round(score * 0.75 + sourceScore * 0.25);

  return Math.max(0, Math.min(score, 100));
};

const getRejectionReason = ({
  lead,
  hasEmail,
  hasPhone,
  hasWebsite,
  verifiedEmail,
}: {
  lead: Lead;
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  verifiedEmail: boolean;
}) => {
  if (
    lead.rejectionReason &&
    blockedRejectionReasons.has(lead.rejectionReason)
  ) {
    return lead.rejectionReason;
  }

  /**
   * Keep this intentionally softer:
   * A lead can still be useful with phone only or website only.
   * Do not reject every non-business-email lead.
   */
  if (!hasPhone && !hasEmail && !hasWebsite) {
    return 'missing_contact';
  }

  if (lead.mobile?.trim() && !hasPhone) {
    return 'invalid_phone';
  }

  if (lead.email?.trim() && !hasEmail) {
    return 'invalid_email';
  }

  /**
   * Only mark missing_email if your product strictly requires email.
   * Otherwise, avoid rejecting valid phone/website leads.
   */
  if (!hasEmail && !hasPhone && hasWebsite) {
    return undefined;
  }

  if (hasEmail && !verifiedEmail) {
    return undefined;
  }

  return undefined;
};

export const enrichLead = (lead: Lead): Lead => {
  const email = normalizeEmail(lead.email);
  const mobile = normalizeUsPhone(lead.mobile);
  const website = normalizeWebsite(lead.website);
  const source = normalizeSource(lead.source);

  const hasEmail = isValidEmail(email);
  const verifiedEmail = isLikelyBusinessEmail(email);

  const hasPhone = isValidUsPhone(mobile);
  const hasWebsite = Boolean(website);

  const sourceScore = getSourceScore({
    ...lead,
    source,
  });

  const rejectionReason = getRejectionReason({
    lead,
    hasEmail,
    hasPhone,
    hasWebsite,
    verifiedEmail,
  });

  const enriched: Lead = {
    ...lead,
    email: hasEmail ? email : '',
    mobile,
    website,
    source,
    rejectionReason,
    hasEmail,
    hasPhone,
    hasWebsite,
    verifiedEmail,
    verifiedPhone: hasPhone,
    sourceScore,
  };

  return {
    ...enriched,
    confidence: Math.max(
      Number(enriched.confidence ?? 0),
      scoreLead(enriched),
    ),

    /**
     * Add this optional field to Lead if possible:
     * qualityLevel?: LeadQualityLevel;
     */
    qualityLevel: getQualityLevel(enriched),
  } as Lead;
};

export const enrichLeads = (leads: Lead[]) => {
  return leads
    .map(enrichLead)
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        Number(right.hasPhone) - Number(left.hasPhone) ||
        Number(right.hasEmail) - Number(left.hasEmail) ||
        Number(right.hasWebsite) - Number(left.hasWebsite) ||
        left.name.localeCompare(right.name),
    );
};