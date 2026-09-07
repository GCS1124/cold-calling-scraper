export const leadFeedbackEventTypes = [
  'wrong_phone',
  'wrong_business',
  'wrong_person',
  'former_employee',
  'duplicate',
  'do_not_contact',
  'useful',
] as const;

export type LeadFeedbackEventType = (typeof leadFeedbackEventTypes)[number];

export type FeedbackLeadLike = {
  id: string;
  name: string;
  organizationName?: string;
  mobile?: string;
  website?: string;
  listingUrl?: string;
  address?: string;
  city?: string;
  state?: string;
  stateCode?: string;
  source?: string;
  hasPhone?: boolean;
};

const normalizePart = (value: string | undefined) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 180);

const normalizePhone = (value: string | undefined) => {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length >= 7 && digits.length <= 15 ? digits : '';
};

const canonicalHost = (value: string | undefined) => {
  if (!value?.trim()) return '';

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const canonicalLinkedInProfile = (value: string | undefined) => {
  if (!value?.trim()) return '';

  try {
    const url = new URL(value.trim());
    if (url.hostname.toLowerCase() !== 'linkedin.com' && url.hostname.toLowerCase() !== 'www.linkedin.com') {
      return '';
    }

    if (!/^\/(?:in|pub)\//i.test(url.pathname)) return '';
    return `linkedin.com${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return '';
  }
};

const isPublicLinkedInLead = (lead: FeedbackLeadLike) =>
  /linkedin\.com\/(?:in|pub)\//i.test(lead.listingUrl ?? '') ||
  /linkedin/i.test(lead.source ?? '');

const organizationKey = (lead: FeedbackLeadLike) => {
  const explicitName = normalizePart(lead.organizationName);
  const fallbackName = !isPublicLinkedInLead(lead) ? normalizePart(lead.name) : '';
  const name = explicitName || fallbackName;
  const host = canonicalHost(lead.website);
  const location =
    normalizePart(lead.address) ||
    [normalizePart(lead.city), normalizePart(lead.stateCode || lead.state)]
      .filter(Boolean)
      .join('|');

  if (!name && !location) return '';

  return `organization:${[
    name,
    location,
    host,
  ].join('|')}`.slice(0, 480);
};

const profileKey = (lead: FeedbackLeadLike) => {
  const profile = canonicalLinkedInProfile(lead.listingUrl);
  return profile ? `profile:${profile}` : '';
};

const phoneKey = (lead: FeedbackLeadLike) => {
  const phone = lead.hasPhone === false ? '' : normalizePhone(lead.mobile);
  return phone ? `phone:${phone}` : '';
};

const personKey = (lead: FeedbackLeadLike) => {
  const name = normalizePart(lead.name);
  const profile = canonicalLinkedInProfile(lead.listingUrl);
  const organization = organizationKey(lead);
  if (!name && !profile) return '';
  return `person:${name}|${profile}|${organization}`.slice(0, 480);
};

const phoneAssociationKey = (lead: FeedbackLeadLike) => {
  const phone = phoneKey(lead);
  if (!phone) return '';

  const anchor =
    organizationKey(lead) ||
    profileKey(lead) ||
    `person-name:${normalizePart(lead.name)}`;
  return anchor ? `phone-association:${phone}|${anchor}`.slice(0, 512) : '';
};

const uniqueKeys = (keys: string[]) => [...new Set(keys.filter(Boolean))];

/** All safe identity keys used to remove a previously flagged lead. */
export const getLeadSuppressionLookupKeys = (lead: FeedbackLeadLike) =>
  uniqueKeys([
    organizationKey(lead),
    profileKey(lead),
    personKey(lead),
    phoneAssociationKey(lead),
  ]);

/** Keys are derived from the stored lead; the browser never submits contact values. */
export const getLeadFeedbackSuppressionKeys = (
  lead: FeedbackLeadLike,
  eventType: LeadFeedbackEventType,
) => {
  const organization = organizationKey(lead);
  const profile = profileKey(lead);
  const person = personKey(lead);
  const phoneAssociation = phoneAssociationKey(lead);

  switch (eventType) {
    case 'wrong_phone':
      return uniqueKeys([phoneAssociation]);
    case 'wrong_person':
    case 'former_employee':
      return uniqueKeys([profile, person]);
    case 'wrong_business':
    case 'do_not_contact':
      return uniqueKeys([organization, profile, person]);
    case 'duplicate':
      return uniqueKeys([organization, profile, person, phoneAssociation]);
    case 'useful':
      return [];
  }
};

export const getLeadFeedbackEntityKey = (
  lead: FeedbackLeadLike,
  eventType: LeadFeedbackEventType,
) =>
  getLeadFeedbackSuppressionKeys(lead, eventType)[0] ??
  `lead:${normalizePart(lead.id).slice(0, 240)}`;

export const filterSuppressedLeads = <T extends FeedbackLeadLike>(
  leads: T[],
  suppressionKeys: ReadonlySet<string>,
) => {
  if (!suppressionKeys.size) {
    return { leads, suppressedCount: 0 };
  }

  const visible: T[] = [];
  let suppressedCount = 0;

  for (const lead of leads) {
    const suppressed = getLeadSuppressionLookupKeys(lead).some((key) =>
      suppressionKeys.has(key),
    );

    if (suppressed) {
      suppressedCount += 1;
    } else {
      visible.push(lead);
    }
  }

  return { leads: visible, suppressedCount };
};
