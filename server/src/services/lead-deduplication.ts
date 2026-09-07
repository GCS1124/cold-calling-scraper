import type { EmploymentStatus, Lead, PublicSocialLink } from '../types/lead';
import { collectContactEvidence, getContactEvidence, mergeContactEvidence, normalizeContactPhone } from './contact-evidence';
import { withLeadQuality } from './lead-quality';
import { preferWebsiteAssessment } from './website-assessment';

const companySuffixPattern =
  /\b(private limited|pvt ltd|pvt\. ltd\.|private ltd|ltd|limited|llc|inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.)\b/gi;

const canonicalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(companySuffixPattern, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeText = (value?: string) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const ownerRolePattern =
  /\b(founder|co-founder|owner|co-owner|business owner|owner operator|proprietor|franchisee|franchise owner|president|principal|managing partner|managing member|brand owner|brand founder|practice owner|clinic owner|store owner|agency principal|insurance agency owner|dealer principal)\b/i;

const isOwnerRoleTerm = (term: string) => ownerRolePattern.test(term);

const isLinkedInProfileListing = (value?: string) => {
  if (!value?.trim()) {
    return false;
  }

  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();

    return (
      (hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com')) &&
      /^\/(?:in|pub)\//i.test(url.pathname)
    );
  } catch {
    return false;
  }
};

const pickValue = (...values: Array<string | undefined>) =>
  values.find((value) => Boolean(value?.trim())) ?? '';

const mergePublicSocialLinks = (group: Lead[]): PublicSocialLink[] => {
  const links = new Map<string, PublicSocialLink>();

  group.flatMap((lead) => lead.publicSocialLinks ?? []).forEach((link) => {
    const url = link.url.trim();

    if (url && !links.has(url)) {
      links.set(url, { platform: link.platform, url });
    }
  });

  return [...links.values()].slice(0, 20);
};

type PublicEvidence = NonNullable<Lead['publicEvidence']>;
type PublicEvidenceSource = NonNullable<PublicEvidence['sources']>[number];

const mergePublicEvidence = (group: Lead[]) => {
  const evidence = group.flatMap((lead) => (lead.publicEvidence ? [lead.publicEvidence] : []));
  const sources = new Map<string, PublicEvidenceSource>();

  evidence.flatMap((entry) => entry.sources ?? []).forEach((source) => {
    const key = normalizeText(source.providerName);
    const previous = sources.get(key);

    if (!previous) {
      sources.set(key, { ...source });
      return;
    }

    sources.set(key, {
      providerName: previous.providerName,
      profileTitle:
        (source.profileTitle?.length ?? 0) > (previous.profileTitle?.length ?? 0)
          ? source.profileTitle
          : previous.profileTitle,
      profileSnippet:
        (source.profileSnippet?.length ?? 0) > (previous.profileSnippet?.length ?? 0)
          ? source.profileSnippet
          : previous.profileSnippet,
    });
  });

  const profileTitle = pickValue(
    ...evidence
      .map((entry) => entry.profileTitle)
      .sort((left, right) => (right?.length ?? 0) - (left?.length ?? 0)),
  );
  const profileSnippet = pickValue(
    ...evidence
      .map((entry) => entry.profileSnippet)
      .sort((left, right) => (right?.length ?? 0) - (left?.length ?? 0)),
  );

  if (!profileTitle && !profileSnippet && sources.size === 0) {
    return undefined;
  }

  return {
    ...(profileTitle ? { profileTitle } : {}),
    ...(profileSnippet ? { profileSnippet } : {}),
    ...(sources.size > 0 ? { sources: [...sources.values()] } : {}),
  } satisfies PublicEvidence;
};

const mergeResearchEvidence = (group: Lead[]) => {
  const evidence = new Map<string, NonNullable<Lead['evidence']>[number]>();

  group.flatMap((lead) => lead.evidence ?? []).forEach((item) => {
    const key = `${item.sourceUrl}|${item.claim}`.toLowerCase();
    if (!evidence.has(key)) {
      evidence.set(key, { ...item });
    }
  });

  return [...evidence.values()].slice(0, 30);
};

const employmentStatusRank: EmploymentStatus[] = [
  'current',
  'probable',
  'uncertain',
  'former',
  'unverified',
];

const mergeEmploymentStatus = (group: Lead[]): EmploymentStatus | undefined => {
  const statuses = new Set(
    group
      .map((lead) => lead.employmentStatus)
      .filter((status): status is EmploymentStatus => Boolean(status)),
  );

  if (!statuses.size) {
    return undefined;
  }

  if (statuses.has('conflicting') || (statuses.has('current') && statuses.has('former'))) {
    return 'conflicting';
  }

  return employmentStatusRank.find((status) => statuses.has(status)) ?? 'unverified';
};

const mergeMatchSignals = (group: Lead[]) => {
  const signals = group.flatMap((lead) => (lead.matchSignals ? [lead.matchSignals] : []));

  if (signals.length === 0) {
    return undefined;
  }

  const publicProviderNames = [
    ...new Map(
      signals
        .flatMap((signal) => signal.publicProviderNames ?? [])
        .map((name) => [normalizeText(name), name] as const)
        .filter(([key]) => Boolean(key)),
    ).values(),
  ];

  const categoryMatchedTerms = [
    ...new Set(
      signals
        .flatMap((signal) => signal.categoryMatchedTerms ?? [])
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
  const roleMatchedTerms = [
    ...new Set(
      signals
        .flatMap((signal) => signal.roleMatchedTerms ?? [])
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
  const queryFamilies = [
    ...new Set(
      signals
        .flatMap((signal) => signal.queryFamilies ?? [])
        .map((family) => family.trim())
        .filter(Boolean),
    ),
  ];
  const locationEvidence = signals
    .map((signal) => signal.locationEvidence?.trim())
    .find(Boolean);

  return {
    queryMatches: Math.max(...signals.map((signal) => signal.queryMatches)),
    publicSources: Math.max(
      ...signals.map((signal) => signal.publicSources),
      publicProviderNames.length,
    ),
    ...(publicProviderNames.length > 0 ? { publicProviderNames } : {}),
    ...(categoryMatchedTerms.length > 0 ? { categoryMatchedTerms } : {}),
    ...(roleMatchedTerms.length > 0 ? { roleMatchedTerms } : {}),
    ...(queryFamilies.length > 0 ? { queryFamilies } : {}),
    ...(locationEvidence ? { locationEvidence } : {}),
    categoryMatched: signals.some((signal) => signal.categoryMatched),
    ownerMatched:
      signals.some((signal) => signal.ownerMatched) || roleMatchedTerms.some(isOwnerRoleTerm),
    roleMatched: signals.some((signal) => signal.roleMatched),
    locationMatched: signals.some((signal) => signal.locationMatched),
  } satisfies NonNullable<Lead['matchSignals']>;
};

const toDomain = (value?: string) => {
  if (!value?.trim()) {
    return '';
  }

  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return '';
  }
};

const normalizeListingUrl = (value?: string) => {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    return '';
  }

  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    url.hash = '';
    if (/(?:^|\.)linkedin\.com$/i.test(url.hostname)) {
      url.hostname = 'linkedin.com';
      url.protocol = 'https:';
      url.search = '';
    }
    const pathname =
      url.pathname !== '/' && url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname === '/'
          ? ''
          : url.pathname;

    return `${url.protocol}//${url.host.replace(/^www\./, '')}${pathname}${url.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
};

const toPhoneKey = (value?: string) => {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }

  return digits.length === 10 ? digits : '';
};

const buildIdentityKeys = (lead: Lead) => {
  if (isLinkedInProfileListing(lead.listingUrl)) {
    return [`profile:${normalizeListingUrl(lead.listingUrl)}`];
  }
  const keys: string[] = [];
  const domain = toDomain(lead.website);
  const phone = toPhoneKey(lead.mobile);
  const nameKey = canonicalizeName(lead.name);
  const cityKey = normalizeText(lead.city);

  // A LinkedIn profile represents a person, while its public website usually
  // represents the employer. Do not collapse multiple people at one employer
  // into one lead just because their profiles expose the same domain.
  if (domain && !isLinkedInProfileListing(lead.listingUrl)) {
    keys.push(`domain:${domain}`);
  }

  if (phone) {
    keys.push(`phone:${phone}`);
  }

  if (lead.listingUrl?.trim()) {
    keys.push(`listing:${normalizeListingUrl(lead.listingUrl)}`);
  }

  if (nameKey && cityKey) {
    keys.push(`name-city:${nameKey}|${cityKey}`);
  }

  return keys;
};

const compatibleBusinesses = (left: Lead, right: Lead) => {
  if (isLinkedInProfileListing(left.listingUrl) || isLinkedInProfileListing(right.listingUrl)) {
    return normalizeListingUrl(left.listingUrl) === normalizeListingUrl(right.listingUrl);
  }
  if (left.listingUrl && right.listingUrl &&
    normalizeListingUrl(left.listingUrl) === normalizeListingUrl(right.listingUrl)) return true;
  for (const field of ['stateCode', 'city'] as const) {
    if (left[field] && right[field] && normalizeText(left[field]) !== normalizeText(right[field])) return false;
  }
  // Shared domains and switchboards do not identify an individual branch.
  const street = (lead: Lead) => /^\s*\d+\b/.test(lead.address ?? '')
    ? normalizeText(lead.address?.split(',')[0]).replace(/[.]/g, '')
      .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\broad\b/g, 'rd')
    : '';
  if (street(left) && street(right) && street(left) !== street(right)) return false;
  const sameName = canonicalizeName(left.name) === canonicalizeName(right.name);
  const sameDomain = toDomain(left.website) && toDomain(left.website) === toDomain(right.website);
  const leftName = canonicalizeName(left.name);
  const rightName = canonicalizeName(right.name);
  const relatedName = Math.min(leftName.split(' ').length, rightName.split(' ').length) >= 2 &&
    (leftName.startsWith(`${rightName} `) || rightName.startsWith(`${leftName} `));
  const sameStreet = street(left) && normalizeText(left.address) === normalizeText(right.address);
  return Boolean(sameName || sameDomain || (relatedName && sameStreet));
};

const mergeGroup = (group: Lead[]) => {
  const sorted = [...group].sort((left, right) => right.confidence - left.confidence);
  const shortestNamed = [...group].sort((left, right) => left.name.length - right.name.length)[0] ?? sorted[0];
  const sources = [
    ...new Set(
      group.flatMap((lead) =>
        lead.source
          .split(',')
          .map((source) => source.trim())
          .filter(Boolean),
      ),
    ),
  ];
  const phoneLead = sorted.find((lead) => normalizeContactPhone(lead.mobile) && getContactEvidence(lead, 'phone').length)
    ?? sorted.find((lead) => normalizeContactPhone(lead.mobile));
  const emailLead = sorted.find((lead) => lead.hasEmail && getContactEvidence(lead, 'email').length)
    ?? sorted.find((lead) => lead.hasEmail && lead.email);
  const websiteAssessment = group
    .map((lead) => lead.websiteAssessment)
    .filter((assessment): assessment is NonNullable<Lead['websiteAssessment']> => Boolean(assessment))
    .reduce<NonNullable<Lead['websiteAssessment']> | undefined>(
      (current, incoming) => preferWebsiteAssessment(current, incoming),
      undefined,
    );

  return withLeadQuality({
    ...sorted[0],
    name: shortestNamed.name,
    headline: pickValue(...sorted.map((lead) => lead.headline)),
    organizationName: pickValue(...sorted.map((lead) => lead.organizationName)),
    originalRole: pickValue(...sorted.map((lead) => lead.originalRole || lead.headline)),
    normalizedRole: pickValue(...sorted.map((lead) => lead.normalizedRole)),
    decisionMaker: group.some((lead) => lead.decisionMaker === true),
    employmentStatus: mergeEmploymentStatus(group),
    mobile: phoneLead?.mobile ?? '',
    email: emailLead?.email ?? '',
    website: pickValue(...sorted.map((lead) => lead.website)),
    ...(websiteAssessment ? { websiteAssessment } : {}),
    contactSourceUrl: phoneLead ? getContactEvidence(phoneLead, 'phone')[0]?.sourceUrl : undefined,
    contactEvidence: mergeContactEvidence(group.flatMap(collectContactEvidence)),
    publicSocialLinks: mergePublicSocialLinks(group),
    listingUrl: pickValue(...sorted.map((lead) => lead.listingUrl)),
    address: pickValue(...sorted.map((lead) => lead.address)),
    state: pickValue(...sorted.map((lead) => lead.state)),
    stateCode: pickValue(...sorted.map((lead) => lead.stateCode)),
    postalCode: pickValue(...sorted.map((lead) => lead.postalCode)),
    zip: pickValue(...sorted.map((lead) => lead.zip)),
    latitude: sorted.find((lead) => lead.latitude !== undefined)?.latitude,
    longitude: sorted.find((lead) => lead.longitude !== undefined)?.longitude,
    source: sources.join(', '),
    confidence: Math.max(...sorted.map((lead) => lead.confidence)),
    publicEvidence: mergePublicEvidence(group),
    evidence: mergeResearchEvidence(group),
    opportunitySignals: [
      ...new Set(group.flatMap((lead) => lead.opportunitySignals ?? []).map((signal) => signal.trim()).filter(Boolean)),
    ],
    scores: sorted[0]?.scores,
    matchSignals: mergeMatchSignals(group),
    hasEmail: Boolean(emailLead?.hasEmail),
    hasPhone: Boolean(phoneLead?.hasPhone),
    hasWebsite: sorted.some((lead) => lead.hasWebsite),
    verifiedEmail: Boolean(emailLead?.verifiedEmail),
    verifiedPhone: Boolean(phoneLead?.verifiedPhone),
    rejectionReason:
      sorted.find((lead) => lead.rejectionReason === 'blocked_website')?.rejectionReason ??
      sorted.find((lead) => lead.rejectionReason === 'blocked_google')?.rejectionReason ??
      sorted.find((lead) => lead.rejectionReason)?.rejectionReason,
    crawlAttempts: Math.max(...group.map((lead) => lead.crawlAttempts ?? 0)),
  });
};

export const deduplicateLeads = (leads: Lead[]) => {
  if (leads.length <= 1) {
    return [...leads];
  }

  const parent = leads.map((_, index) => index);
  const members = leads.map((lead) => [lead]);

  const find = (index: number): number => {
    if (parent[index] !== index) {
      parent[index] = find(parent[index]);
    }

    return parent[index] ?? index;
  };

  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);

    if (leftRoot === rightRoot) {
      return;
    }
    if (!members[leftRoot].every((leftLead) => members[rightRoot].every((rightLead) =>
      compatibleBusinesses(leftLead, rightLead)))) return;

    if (leftRoot < rightRoot) {
      parent[rightRoot] = leftRoot;
      members[leftRoot].push(...members[rightRoot]);
      return;
    }

    parent[leftRoot] = rightRoot;
    members[rightRoot].push(...members[leftRoot]);
  };

  const seenByKey = new Map<string, number[]>();

  leads.forEach((lead, index) => {
    for (const key of buildIdentityKeys(lead)) {
      const existingIndices = seenByKey.get(key) ?? [];
      for (const existingIndex of existingIndices) union(index, existingIndex);
      seenByKey.set(key, [...existingIndices, index]);
    }
  });

  const groups = new Map<number, Lead[]>();

  leads.forEach((lead, index) => {
    const root = find(index);
    const group = groups.get(root);

    if (group) {
      group.push(lead);
      return;
    }

    groups.set(root, [lead]);
  });

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => mergeGroup(group));
};
