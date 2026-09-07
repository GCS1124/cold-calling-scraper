import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';

import type { WebsiteAssessment } from '../../../shared/lead-quality';
import type { Lead } from '../types/lead';
import { isPublicHttpUrl } from '../utils/public-url';

type RobotsRule = {
  allow: boolean;
  pattern: string;
  specificity: number;
};

type RobotsGroup = {
  agents: string[];
  rules: RobotsRule[];
};

export type RobotsPolicy = {
  status: 'allowed' | 'blocked' | 'unknown';
  isAllowed: (url: URL | string) => boolean;
};

export type WebsiteDocumentAssessmentInput = {
  lead: Lead;
  sourceUrl: string;
  html: string;
  observedAt?: string;
  robots?: RobotsPolicy['status'];
  phoneValues?: string[];
  emailValues?: string[];
  addressValues?: string[];
};

const challengePattern =
  /access denied|forbidden|captcha|cloudflare|attention required|bot detection|verify you are human|unusual traffic|enable javascript to continue/i;

const parkedPattern =
  /domain (?:name )?(?:is )?for sale|buy this domain|parked free|parking page|coming soon|under construction/i;

const stopWords = new Set([
  'and',
  'at',
  'by',
  'co',
  'company',
  'corp',
  'corporation',
  'dr',
  'for',
  'in',
  'inc',
  'llc',
  'ltd',
  'of',
  'on',
  'the',
  'this',
  'with',
]);

const normalizeText = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenize = (value: string) =>
  [...new Set(
    normalizeText(value)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stopWords.has(token)),
  )];

const getCanonicalHost = (value: string) => {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
};

const getResolvedHost = (sourceUrl: string, canonicalHost: string) => {
  const resolvedHost = getCanonicalHost(sourceUrl);
  return resolvedHost && resolvedHost !== canonicalHost ? resolvedHost : undefined;
};

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const flattenJsonLd = (value: unknown): unknown[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value !== 'object') return [];

  const objectValue = value as Record<string, unknown>;
  const graph = objectValue['@graph'];

  return [
    objectValue,
    ...(Array.isArray(graph) ? graph.flatMap(flattenJsonLd) : []),
  ];
};

const extractStructuredSignals = (html: string) => {
  const $ = cheerio.load(html);
  const names: string[] = [];
  const types: string[] = [];
  const addresses: string[] = [];
  const telephones: string[] = [];

  $('script[type="application/ld+json"]').each((_index, element) => {
    const parsed = safeJsonParse($(element).text().trim());

    for (const entry of flattenJsonLd(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      const objectValue = entry as Record<string, unknown>;
      const typeValue = objectValue['@type'];
      const typeValues = Array.isArray(typeValue) ? typeValue : [typeValue];

      typeValues
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .forEach((value) => types.push(value));

      const name = String(objectValue.name ?? '').replace(/\s+/g, ' ').trim();
      if (name) names.push(name);

      const telephone = String(objectValue.telephone ?? '').trim();
      if (telephone) telephones.push(telephone);

      const address = objectValue.address;
      if (typeof address === 'string') {
        addresses.push(address.replace(/\s+/g, ' ').trim());
      } else if (address && typeof address === 'object') {
        const addressValue = address as Record<string, unknown>;
        addresses.push(
          [
            addressValue.streetAddress,
            addressValue.addressLocality,
            addressValue.addressRegion,
            addressValue.postalCode,
          ]
            .map((value) => String(value ?? '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(', '),
        );
      }
    }
  });

  return {
    names: [...new Set(names.filter(Boolean))],
    types: [...new Set(types)],
    addresses: [...new Set(addresses.filter(Boolean))],
    telephones: [...new Set(telephones.filter(Boolean))],
  };
};

const wildcardPattern = (value: string) => {
  const endAnchored = value.endsWith('$');
  const source = endAnchored ? value.slice(0, -1) : value;
  const escaped = source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${endAnchored ? '$' : ''}`, 'i');
};

const flushRobotsGroup = (
  groups: RobotsGroup[],
  agents: string[],
  rules: RobotsRule[],
) => {
  if (agents.length) {
    groups.push({ agents: [...agents], rules: [...rules] });
  }
};

export const parseRobotsTxt = (
  body: string,
  userAgent = 'leadfinderpro',
): RobotsPolicy => {
  const groups: RobotsGroup[] = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let sawRule = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();

    if (!line) {
      flushRobotsGroup(groups, agents, rules);
      agents = [];
      rules = [];
      sawRule = false;
      continue;
    }

    const separator = line.indexOf(':');
    if (separator < 0) continue;

    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === 'user-agent') {
      if (sawRule) {
        flushRobotsGroup(groups, agents, rules);
        agents = [];
        rules = [];
        sawRule = false;
      }

      if (value) agents.push(value.toLowerCase());
      continue;
    }

    if ((directive === 'allow' || directive === 'disallow') && agents.length) {
      sawRule = true;
      if (!value) continue;

      rules.push({
        allow: directive === 'allow',
        pattern: value,
        specificity: value.replace(/\*/g, '').length,
      });
    }
  }

  flushRobotsGroup(groups, agents, rules);

  const normalizedAgent = userAgent.toLowerCase();
  const specificGroups = groups.filter((group) =>
    group.agents.some((agent) => agent !== '*' && normalizedAgent.includes(agent)),
  );
  const wildcardGroups = groups.filter((group) => group.agents.includes('*'));
  const selectedGroups = specificGroups.length ? specificGroups : wildcardGroups;
  const selectedRules = selectedGroups.flatMap((group) => group.rules);

  return {
    status: 'allowed',
    isAllowed: (value) => {
      try {
        const url = typeof value === 'string' ? new URL(value) : value;
        const path = `${url.pathname}${url.search}`;
        const matchingRules = selectedRules.filter((rule) => wildcardPattern(rule.pattern).test(path));
        if (!matchingRules.length) return true;

        matchingRules.sort(
          (left, right) => right.specificity - left.specificity || Number(right.allow) - Number(left.allow),
        );
        return matchingRules[0]?.allow ?? true;
      } catch {
        return false;
      }
    },
  };
};

export const unknownRobotsPolicy = (): RobotsPolicy => ({
  status: 'unknown',
  isAllowed: () => true,
});

export const blockedRobotsPolicy = (): RobotsPolicy => ({
  status: 'blocked',
  isAllowed: () => false,
});

const hasAllTokens = (haystack: string, tokens: string[]) =>
  tokens.length >= 2
    ? tokens.every((token) => haystack.includes(token))
    : tokens.length === 1 && haystack.includes(tokens[0]);

const hasAnyToken = (haystack: string, tokens: string[]) =>
  tokens.some((token) => haystack.includes(token));

const normalizeDigits = (value: string) => value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

const hasMatchingPhone = (lead: Lead, phoneValues: string[], pageText: string) => {
  const candidate = normalizeDigits(lead.mobile ?? '');
  if (!candidate || candidate.length < 10) return false;

  return [
    ...phoneValues,
    pageText,
  ].some((value) => normalizeDigits(value).includes(candidate));
};

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export const assessWebsiteDocument = ({
  lead,
  sourceUrl,
  html,
  observedAt = new Date().toISOString(),
  robots = 'unknown',
  phoneValues = [],
  emailValues = [],
  addressValues = [],
}: WebsiteDocumentAssessmentInput): WebsiteAssessment => {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  const headings = $('h1, h2').map((_index, element) => $(element).text()).get().join(' ');
  const structured = extractStructuredSignals(html);
  const structuredText = [
    ...structured.names,
    ...structured.types,
    ...structured.addresses,
    ...structured.telephones,
  ].join(' ');
  const searchableText = normalizeText(`${title} ${headings} ${bodyText} ${structuredText}`);
  const leadNameTokens = tokenize(lead.name);
  const categoryTokens = tokenize(lead.category);
  const locationTokens = tokenize(`${lead.city} ${lead.state ?? ''} ${lead.stateCode ?? ''}`)
    .filter((token) => token.length >= 2);
  const candidateAddressTokens = tokenize(lead.address ?? '');
  const postalCode = (lead.postalCode ?? lead.zip ?? '').trim();
  const structuredBusiness = structured.types.some((type) =>
    /business|organization|clinic|medical|professionalservice|store|restaurant/i.test(type),
  );
  const nameMatch = hasAllTokens(searchableText, leadNameTokens);
  const categoryMatch = hasAnyToken(searchableText, categoryTokens);
  const locationMatch =
    (postalCode.length >= 5 && searchableText.includes(normalizeText(postalCode))) ||
    hasAnyToken(searchableText, locationTokens);
  const addressMatch = candidateAddressTokens.length > 0 && hasAnyToken(searchableText, candidateAddressTokens);
  const phoneMatch = hasMatchingPhone(lead, phoneValues, searchableText);
  const contactPresent = phoneValues.length > 0 || emailValues.length > 0;
  const challenge = challengePattern.test(`${title} ${bodyText}`);
  const parked = parkedPattern.test(`${title} ${bodyText}`);
  const identitySignals = Number(nameMatch) + Number(categoryMatch) + Number(locationMatch) + Number(addressMatch) + Number(phoneMatch);

  const reasons: string[] = [];
  const gaps: string[] = [];
  let score = 0;

  if (structuredBusiness) {
    score += 25;
    reasons.push('Structured public business markup was found.');
  } else {
    gaps.push('No public business schema markup was found.');
  }
  if (nameMatch) {
    score += 30;
    reasons.push('The page text matches the lead name.');
  }
  if (categoryMatch) {
    score += 18;
    reasons.push('The page text matches the requested company category.');
  }
  if (locationMatch) {
    score += 15;
    reasons.push('The page text contains a requested location signal.');
  }
  if (addressMatch) {
    score += 12;
    reasons.push('The page text overlaps the known business address.');
  }
  if (phoneMatch) {
    score += 20;
    reasons.push('The page repeats the candidate phone number.');
  }
  if (contactPresent) {
    score += 10;
    reasons.push('A public contact value was present on this page.');
  } else {
    gaps.push('No public phone or email was observed on this page.');
  }
  if (!nameMatch && !categoryMatch && !locationMatch && !addressMatch && !phoneMatch) {
    gaps.push('Business identity was not matched to the supplied lead fields.');
  }
  if (robots === 'unknown') {
    gaps.push('robots.txt could not be verified for this domain.');
  }
  if (!phoneValues.length) {
    gaps.push('This page did not provide a public phone for the compulsory phone gate.');
  }

  let status: WebsiteAssessment['status'];
  if (robots === 'blocked' || challenge) {
    status = 'blocked';
    score = 0;
    reasons.length = 0;
    reasons.push('The page appears restricted or protected from automated access.');
  } else if (parked) {
    status = 'parked';
    score = 0;
    reasons.length = 0;
    reasons.push('The domain appears parked or offered for sale.');
  } else if (identitySignals >= 2 && score >= 55) {
    status = 'confirmed';
  } else if (contactPresent || identitySignals > 0) {
    status = 'probable';
  } else {
    status = 'unrelated';
  }

  const canonicalHost = getCanonicalHost(sourceUrl);
  const normalizedSourceUrl = isPublicHttpUrl(sourceUrl) ? new URL(sourceUrl).toString() : sourceUrl;

  return {
    version: 1,
    status,
    score: clampScore(score),
    canonicalHost,
    sourceUrl: normalizedSourceUrl,
    resolvedHost: getResolvedHost(sourceUrl, canonicalHost),
    observedAt,
    contentHash: createHash('sha256').update(html).digest('hex'),
    robots,
    reasons: [...new Set(reasons)],
    gaps: [...new Set(gaps)],
  };
};

export const createUnavailableWebsiteAssessment = ({
  sourceUrl,
  observedAt = new Date().toISOString(),
  robots = 'unknown',
  status = 'unavailable',
  reason,
}: {
  sourceUrl: string;
  observedAt?: string;
  robots?: WebsiteAssessment['robots'];
  status?: Extract<WebsiteAssessment['status'], 'unavailable' | 'blocked'>;
  reason: string;
}): WebsiteAssessment => ({
  version: 1,
  status,
  score: 0,
  canonicalHost: getCanonicalHost(sourceUrl),
  sourceUrl,
  observedAt,
  robots,
  reasons: [reason],
  gaps: ['No current website document was available for identity verification.'],
});

const websiteStatusRank: Record<WebsiteAssessment['status'], number> = {
  confirmed: 5,
  probable: 4,
  unrelated: 3,
  parked: 2,
  unavailable: 1,
  blocked: 0,
};

export const preferWebsiteAssessment = (
  current: WebsiteAssessment | undefined,
  incoming: WebsiteAssessment,
) => {
  if (!current) return incoming;

  const currentRank = websiteStatusRank[current.status];
  const incomingRank = websiteStatusRank[incoming.status];

  if (incomingRank > currentRank || (incomingRank === currentRank && incoming.score > current.score)) {
    return incoming;
  }

  return current;
};

export const canUseWebsiteContactEvidence = (assessment: WebsiteAssessment | undefined) =>
  assessment?.status === 'confirmed' || assessment?.status === 'probable';
