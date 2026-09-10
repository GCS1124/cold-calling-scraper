import type { EmploymentStatus, Lead, PublicSocialLink } from '../types/lead';
import { collectContactEvidence, getContactEvidence, mergeContactEvidence, normalizeContactPhone } from './contact-evidence';
import { withLeadQuality } from './lead-quality';
import { preferWebsiteAssessment } from './website-assessment';
import { isPublicHttpUrl } from '../utils/public-url';

const companySuffixPattern =
  /\b(private limited|pvt ltd|pvt\. ltd\.|private ltd|ltd|limited|llc|inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.)\b/gi;

const asString = (value: unknown) => (typeof value === 'string' ? value : '');
const asFiniteNumber = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const canonicalizeName = (value?: unknown) =>
  asString(value)
    .toLowerCase()
    .replace(companySuffixPattern, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeText = (value?: unknown) =>
  asString(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const ownerRolePattern =
  /\b(founder|co-founder|owner|co-owner|business owner|owner operator|proprietor|franchisee|franchise owner|president|principal|managing partner|managing member|brand owner|brand founder|practice owner|clinic owner|store owner|agency principal|insurance agency owner|dealer principal)\b/i;

const isOwnerRoleTerm = (term: string) => ownerRolePattern.test(term);

const isLinkedInProfileListing = (value?: unknown) => {
  const candidate = asString(value);
  if (!candidate.trim()) {
    return false;
  }

  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (!isPublicHttpUrl(url)) {
      return false;
    }
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();

    return (
      (hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com')) &&
      /^\/(?:in|pub)\//i.test(url.pathname)
    );
  } catch {
    return false;
  }
};

const pickValue = (...values: Array<unknown>) =>
  values.map(asString).find((value) => Boolean(value.trim())) ?? '';

const mergePublicSocialLinks = (group: Lead[]): PublicSocialLink[] => {
  const links = new Map<string, PublicSocialLink>();

  group.flatMap((lead) => Array.isArray(lead.publicSocialLinks) ? lead.publicSocialLinks : []).forEach((link) => {
    if (!link || typeof link.url !== 'string' || typeof link.platform !== 'string') return;
    const url = link.url.trim();

    if (url && isPublicHttpUrl(url) && !links.has(url)) {
      links.set(url, { platform: link.platform, url });
    }
  });

  return [...links.values()].slice(0, 20);
};

type PublicEvidence = NonNullable<Lead['publicEvidence']>;
type PublicEvidenceSource = NonNullable<PublicEvidence['sources']>[number];

const mergePublicEvidence = (group: Lead[]) => {
  const evidence = group.flatMap((lead) => (
    lead.publicEvidence && typeof lead.publicEvidence === 'object'
      ? [lead.publicEvidence]
      : []
  ));
  const sources = new Map<string, PublicEvidenceSource>();

  evidence.flatMap((entry) => Array.isArray(entry.sources) ? entry.sources : []).forEach((source) => {
    if (!source || typeof source.providerName !== 'string') return;
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

  group.flatMap((lead) => Array.isArray(lead.evidence) ? lead.evidence : []).forEach((item) => {
    if (
      !item ||
      typeof item.sourceUrl !== 'string' ||
      typeof item.sourceName !== 'string' ||
      typeof item.claim !== 'string' ||
      !isPublicHttpUrl(item.sourceUrl)
    ) return;
    const sourceUrl = item.sourceUrl.trim();
    const claim = item.claim.trim().slice(0, 2_000);
    if (!sourceUrl || !claim) return;
    const key = `${sourceUrl}|${claim}`.toLowerCase();
    if (!evidence.has(key)) {
      evidence.set(key, { ...item, sourceUrl, claim });
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
  const signals = group.flatMap((lead) => (
    lead.matchSignals && typeof lead.matchSignals === 'object'
      ? [lead.matchSignals]
      : []
  ));

  if (signals.length === 0) {
    return undefined;
  }

  const publicProviderNames = [
    ...new Map(
      signals
        .flatMap((signal) => Array.isArray(signal.publicProviderNames) ? signal.publicProviderNames : [])
        .filter((name): name is string => typeof name === 'string')
        .map((name) => [normalizeText(name), name] as const)
        .filter(([key]) => Boolean(key)),
    ).values(),
  ];

  const categoryMatchedTerms = [
    ...new Set(
      signals
        .flatMap((signal) => Array.isArray(signal.categoryMatchedTerms) ? signal.categoryMatchedTerms : [])
        .filter((term): term is string => typeof term === 'string')
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
  const roleMatchedTerms = [
    ...new Set(
      signals
        .flatMap((signal) => Array.isArray(signal.roleMatchedTerms) ? signal.roleMatchedTerms : [])
        .filter((term): term is string => typeof term === 'string')
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
  const queryFamilies = [
    ...new Set(
      signals
        .flatMap((signal) => Array.isArray(signal.queryFamilies) ? signal.queryFamilies : [])
        .filter((family): family is string => typeof family === 'string')
        .map((family) => family.trim())
        .filter(Boolean),
    ),
  ];
  const locationEvidence = signals
    .map((signal) => asString(signal.locationEvidence).trim())
    .find(Boolean);

  return {
    queryMatches: Math.max(...signals.map((signal) => asFiniteNumber(signal.queryMatches))),
    publicSources: Math.max(
      ...signals.map((signal) => asFiniteNumber(signal.publicSources)),
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

const toDomain = (value?: unknown) => {
  const candidate = asString(value);
  if (!candidate.trim()) {
    return '';
  }

  try {
    return new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return '';
  }
};

const normalizeListingUrl = (value?: unknown) => {
  const trimmed = asString(value).trim();

  if (!trimmed) {
    return '';
  }

  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.username || url.password) return '';
    if (!isPublicHttpUrl(url)) return '';
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
    return '';
  }
};

const toPhoneKey = (value?: unknown) => {
  const digits = asString(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }

  return digits.length === 10 ? digits : '';
};

const buildIdentityKeys = (lead: Lead) => {
  if (isLinkedInProfileListing(lead.listingUrl)) {
    const profileUrl = normalizeListingUrl(lead.listingUrl);
    return profileUrl ? [`profile:${profileUrl}`] : [];
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

  const listingUrl = normalizeListingUrl(lead.listingUrl);
  if (listingUrl) {
    keys.push(`listing:${listingUrl}`);
  }

  if (nameKey && cityKey) {
    keys.push(`name-city:${nameKey}|${cityKey}`);
  }

  return keys;
};

const compatibleBusinesses = (left: Lead, right: Lead) => {
  if (isLinkedInProfileListing(left.listingUrl) || isLinkedInProfileListing(right.listingUrl)) {
    const leftProfile = normalizeListingUrl(left.listingUrl);
    const rightProfile = normalizeListingUrl(right.listingUrl);
    return Boolean(leftProfile && rightProfile && leftProfile === rightProfile);
  }
  const leftListingUrl = normalizeListingUrl(left.listingUrl);
  const rightListingUrl = normalizeListingUrl(right.listingUrl);
  if (leftListingUrl && rightListingUrl && leftListingUrl === rightListingUrl) return true;
  for (const field of ['stateCode', 'city'] as const) {
    if (left[field] && right[field] && normalizeText(left[field]) !== normalizeText(right[field])) return false;
  }
  // Shared domains and switchboards do not identify an individual branch.
  const street = (lead: Lead) => /^\s*\d+\b/.test(asString(lead.address))
    ? normalizeText(asString(lead.address).split(',')[0]).replace(/[.]/g, '')
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
  const sorted = [...group].sort(
    (left, right) => asFiniteNumber(right.confidence) - asFiniteNumber(left.confidence),
  );
  const shortestNamed = [...group].sort(
    (left, right) => asString(left.name).length - asString(right.name).length,
  )[0] ?? sorted[0];
  const sources = [
    ...new Set(
      group.flatMap((lead) =>
        asString(lead.source)
          .split(',')
          .map((source) => source.trim())
          .filter(Boolean),
      ),
    ),
  ];
  const phoneLead = sorted.find((lead) => normalizeContactPhone(lead.mobile) && getContactEvidence(lead, 'phone').length)
    ?? sorted.find((lead) => normalizeContactPhone(lead.mobile));
  const mergedPhone = normalizeContactPhone(phoneLead?.mobile);
  const emailLead = sorted.find((lead) => Boolean(lead.hasEmail) && getContactEvidence(lead, 'email').length)
    ?? sorted.find((lead) => Boolean(lead.hasEmail) && asString(lead.email));
  const websiteAssessment = group
    .map((lead) => lead.websiteAssessment)
    .filter((assessment): assessment is NonNullable<Lead['websiteAssessment']> => Boolean(assessment))
    .reduce<NonNullable<Lead['websiteAssessment']> | undefined>(
      (current, incoming) => preferWebsiteAssessment(current, incoming),
      undefined,
    );

  return withLeadQuality({
    ...sorted[0],
    name: asString(shortestNamed.name),
    headline: pickValue(...sorted.map((lead) => lead.headline)),
    organizationName: pickValue(...sorted.map((lead) => lead.organizationName)),
    decisionMakerName: pickValue(...sorted.map((lead) => lead.decisionMakerName)),
    decisionMakerRole: pickValue(...sorted.map((lead) => lead.decisionMakerRole)),
    decisionMakerSourceUrl: pickValue(...sorted.map((lead) => lead.decisionMakerSourceUrl)),
    originalRole: pickValue(...sorted.map((lead) => lead.originalRole || lead.headline)),
    normalizedRole: pickValue(...sorted.map((lead) => lead.normalizedRole)),
    decisionMaker: group.some((lead) => lead.decisionMaker === true),
    employmentStatus: mergeEmploymentStatus(group),
    mobile: asString(phoneLead?.mobile),
    email: asString(emailLead?.email),
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
    confidence: Math.max(...sorted.map((lead) => asFiniteNumber(lead.confidence))),
    publicEvidence: mergePublicEvidence(group),
    evidence: mergeResearchEvidence(group),
    opportunitySignals: [
      ...new Set(
        group
          .flatMap((lead) => Array.isArray(lead.opportunitySignals) ? lead.opportunitySignals : [])
          .filter((signal): signal is string => typeof signal === 'string')
          .map((signal) => signal.trim())
          .filter(Boolean),
      ),
    ],
    scores: sorted[0]?.scores,
    matchSignals: mergeMatchSignals(group),
    hasEmail: Boolean(emailLead?.hasEmail),
    // Recompute derived phone flags from the selected normalized value. A
    // stale persisted flag must not discard a valid public phone during a
    // duplicate merge; the evidence gate still decides whether it is
    // exportable.
    hasPhone: Boolean(mergedPhone),
    hasWebsite: sorted.some((lead) => lead.hasWebsite),
    verifiedEmail: Boolean(emailLead?.verifiedEmail),
    verifiedPhone: Boolean(mergedPhone),
    rejectionReason:
      sorted.find((lead) => lead.rejectionReason === 'blocked_website')?.rejectionReason ??
      sorted.find((lead) => lead.rejectionReason === 'blocked_google')?.rejectionReason ??
      sorted.find((lead) => lead.rejectionReason)?.rejectionReason,
    crawlAttempts: Math.max(...group.map((lead) => asFiniteNumber(lead.crawlAttempts))),
  });
};

export const deduplicateLeads = (leads: Lead[]) => {
  const safeLeads = (Array.isArray(leads) ? leads : []).filter(
    (lead): lead is Lead => Boolean(
      lead &&
        typeof lead === 'object' &&
        typeof lead.name === 'string' &&
        typeof lead.category === 'string' &&
        typeof lead.city === 'string' &&
        typeof lead.source === 'string',
    ),
  );

  if (safeLeads.length <= 1) {
    return [...safeLeads];
  }

  const parent = safeLeads.map((_, index) => index);
  const members = safeLeads.map((lead) => [lead]);

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

  safeLeads.forEach((lead, index) => {
    for (const key of buildIdentityKeys(lead)) {
      const existingIndices = seenByKey.get(key) ?? [];
      for (const existingIndex of existingIndices) union(index, existingIndex);
      seenByKey.set(key, [...existingIndices, index]);
    }
  });

  const groups = new Map<number, Lead[]>();

  safeLeads.forEach((lead, index) => {
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
