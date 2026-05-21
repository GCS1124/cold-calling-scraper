import { parsePhoneNumberFromString } from 'libphonenumber-js';

import type { Lead } from '../types/lead';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

const isLikelyBusinessEmail = (value: string) => {
  if (!emailPattern.test(value)) {
    return false;
  }

  const [, domain = ''] = value.toLowerCase().split('@');
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) {
    return false;
  }

  const topLevelLabel = labels[labels.length - 1] ?? '';
  if (topLevelLabel.length < 2 || topLevelLabel.length > 12) {
    return false;
  }

  return labels.every((label) => /^[a-z0-9-]+$/i.test(label) && label.length <= 30);
};

const normalizeWebsite = (value?: string) => {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const normalizeUsPhone = (value?: string) => {
  if (!value) {
    return '';
  }

  const parsed = parsePhoneNumberFromString(value, 'US');
  if (!parsed?.isValid()) {
    return value.trim();
  }

  return parsed.formatInternational().replace(/-/g, ' ');
};

const scoreLead = (lead: Lead) => {
  let score = 40;

  if (lead.hasEmail) score += 15;
  if (lead.hasPhone) score += 15;
  if (lead.hasWebsite) score += 15;
  if (lead.verifiedEmail) score += 10;
  if (lead.verifiedPhone) score += 10;
  if (lead.source.includes('Google Maps')) score += 10;

  return Math.min(score, 100);
};

export const enrichLead = (lead: Lead): Lead => {
  const email = lead.email?.trim().toLowerCase() ?? '';
  const mobile = normalizeUsPhone(lead.mobile);
  const website = normalizeWebsite(lead.website);
  const hasEmail = emailPattern.test(email);
  const verifiedEmail = isLikelyBusinessEmail(email);
  const parsedPhone = parsePhoneNumberFromString(mobile, 'US');
  const hasPhone = Boolean(parsedPhone?.isValid() && parsedPhone.country === 'US');
  const hasWebsite = website.length > 0;
  const preservedBlockedReason =
    lead.rejectionReason === 'blocked_website' || lead.rejectionReason === 'blocked_google'
      ? lead.rejectionReason
      : undefined;
  const rejectionReason = preservedBlockedReason
    ? preservedBlockedReason
    : !mobile.trim()
      ? 'missing_phone'
      : !hasPhone
        ? 'invalid_phone'
        : !verifiedEmail
          ? 'missing_email'
          : lead.rejectionReason;

  const enriched: Lead = {
    ...lead,
    email,
    mobile,
    website,
    rejectionReason,
    hasEmail,
    hasPhone,
    hasWebsite,
    verifiedEmail,
    verifiedPhone: hasPhone,
    sourceScore:
      lead.sourceScore ??
      (lead.source.includes('Google Maps')
        ? 90
        : lead.source.includes('OpenStreetMap')
          ? 65
          : lead.source.includes('Website Crawl')
            ? 75
            : 50),
  };

  return {
    ...enriched,
    confidence: Math.max(enriched.confidence, scoreLead(enriched)),
  };
};

export const enrichLeads = (leads: Lead[]) => leads.map(enrichLead);
