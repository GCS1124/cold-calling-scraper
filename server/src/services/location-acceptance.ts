import type { Lead } from '../types/lead';
import { usStateNames, type UsStateCode } from '../data/us-states';
import { timezoneStateQueries, type UsTimeZoneCode } from './us-timezones';
import type { NormalizedUsLocation } from './us-location';

type ParsedAddressEvidence = {
  city?: string;
  stateCode?: UsStateCode;
  postalCode?: string;
  confidence: number;
  source: 'address' | 'city-field' | 'state-field' | 'postal-code' | 'coordinates';
};

type StateAliasEntry = {
  code: UsStateCode;
  alias: string;
  tokens: string[];
};

type LeadLocationCandidate = Pick<
  Lead,
  'address' | 'city'
> & {
  state?: string;
  stateCode?: string;
  postalCode?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
};

const countryAliases = new Set([
  'us',
  'usa',
  'u s',
  'u s a',
  'united states',
  'united states of america',
]);

const cityDecorationTokens = new Set([
  'city',
  'town',
  'village',
  'county',
  'metro',
  'area',
]);

const zipPattern = /\b\d{5}(?:-\d{4})?\b/;

const stateAliases: StateAliasEntry[] = [];

const normalizeText = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeCity = (value?: string) => {
  const normalized = normalizeText(value ?? '');

  return normalized
    .split(' ')
    .filter((token) => token && !countryAliases.has(token) && !cityDecorationTokens.has(token))
    .join(' ');
};

const toTitleCase = (value: string) =>
  value
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');

const stateCodesByName = Object.fromEntries(
  Object.entries(usStateNames).map(([code, name]) => [
    normalizeText(name),
    code,
  ]),
) as Record<string, UsStateCode>;

const normalizeStateCode = (value?: string): UsStateCode | undefined => {
  const normalized = normalizeText(value ?? '');

  if (!normalized) {
    return undefined;
  }

  const upper = normalized.toUpperCase();

  if (usStateNames[upper as UsStateCode]) {
    return upper as UsStateCode;
  }

  return stateCodesByName[normalized];
};

for (const code of Object.keys(usStateNames) as UsStateCode[]) {
  const stateName = usStateNames[code];

  stateAliases.push(
    {
      code,
      alias: normalizeText(code),
      tokens: normalizeText(code).split(' '),
    },
    {
      code,
      alias: normalizeText(stateName),
      tokens: normalizeText(stateName).split(' '),
    },
  );
}

stateAliases.sort((left, right) => {
  const tokenDifference = right.tokens.length - left.tokens.length;
  return tokenDifference || right.alias.length - left.alias.length;
});

const isDecorationToken = (token: string) =>
  countryAliases.has(token) || zipPattern.test(token);

const splitAddressSegments = (address: string) =>
  address
    .split(/[,;\n|]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

const findStateMatchInTokens = (tokens: string[]) => {
  if (!tokens.length) {
    return null;
  }

  for (const alias of stateAliases) {
    for (let start = 0; start <= tokens.length - alias.tokens.length; start += 1) {
      const candidate = tokens.slice(start, start + alias.tokens.length);

      if (candidate.some((token, index) => token !== alias.tokens[index])) {
        continue;
      }

      return {
        stateCode: alias.code,
        tokenIndex: start,
        tokenLength: alias.tokens.length,
      };
    }
  }

  return null;
};

const findStateMatch = (value: string) => {
  const tokens = normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);

  const match = findStateMatchInTokens(tokens);

  if (!match) {
    return null;
  }

  return match;
};

const extractPostalCode = (value?: string) => {
  const match = value?.match(zipPattern);
  return match?.[0];
};

const parseSegmentedAddress = (address: string): ParsedAddressEvidence | null => {
  const rawSegments = splitAddressSegments(address);

  if (rawSegments.length <= 1) {
    return null;
  }

  for (let index = rawSegments.length - 1; index >= 0; index -= 1) {
    const segment = rawSegments[index] ?? '';
    const stateMatch = findStateMatch(segment);

    if (!stateMatch) {
      continue;
    }

    const segmentTokens = normalizeText(segment).split(' ').filter(Boolean);
    const beforeStateTokens = segmentTokens.slice(0, stateMatch.tokenIndex);
    const afterStateTokens = segmentTokens.slice(
      stateMatch.tokenIndex + stateMatch.tokenLength,
    );

    const possibleCityFromSameSegment = beforeStateTokens
      .filter((token) => !isDecorationToken(token))
      .join(' ');

    const previousSegmentCity = normalizeCity(rawSegments[index - 1] ?? '');

    const city =
      possibleCityFromSameSegment ||
      previousSegmentCity ||
      undefined;

    return {
      city,
      stateCode: stateMatch.stateCode,
      postalCode: extractPostalCode(address),
      confidence: city ? 90 : 70,
      source: 'address',
    };
  }

  return null;
};

const parseUnsegmentedAddress = (address: string): ParsedAddressEvidence | null => {
  const normalized = normalizeText(address);
  const tokens = normalized.split(' ').filter(Boolean);

  if (tokens.length < 2) {
    return null;
  }

  const stateMatch = findStateMatchInTokens(tokens);

  if (!stateMatch) {
    return null;
  }

  const beforeStateTokens = tokens.slice(0, stateMatch.tokenIndex);
  const afterStateTokens = tokens.slice(stateMatch.tokenIndex + stateMatch.tokenLength);

  const cityTokensFromBefore = beforeStateTokens
    .slice(-3)
    .filter((token) => !isDecorationToken(token));

  const cityTokensFromAfter = afterStateTokens
    .filter((token) => !isDecorationToken(token))
    .slice(0, 3);

  const city =
    cityTokensFromBefore.length > 0
      ? cityTokensFromBefore.join(' ')
      : cityTokensFromAfter.length > 0
        ? cityTokensFromAfter.join(' ')
        : undefined;

  return {
    city,
    stateCode: stateMatch.stateCode,
    postalCode: extractPostalCode(address),
    confidence: city ? 70 : 55,
    source: 'address',
  };
};

const parseAddressEvidence = (address?: string): ParsedAddressEvidence | null => {
  if (!address?.trim()) {
    return null;
  }

  return (
    parseSegmentedAddress(address.trim()) ??
    parseUnsegmentedAddress(address.trim())
  );
};

const parseLeadLocationEvidence = (
  lead: LeadLocationCandidate,
): ParsedAddressEvidence | null => {
  const addressEvidence = parseAddressEvidence(lead.address);

  if (addressEvidence?.stateCode) {
    return addressEvidence;
  }

  const explicitStateCode =
    normalizeStateCode(lead.stateCode) ??
    normalizeStateCode(lead.state);

  const explicitPostalCode =
    lead.postalCode ??
    lead.zip ??
    extractPostalCode(lead.address);

  const city = normalizeCity(lead.city);

  if (explicitStateCode) {
    return {
      city: city || undefined,
      stateCode: explicitStateCode,
      postalCode: explicitPostalCode,
      confidence: city ? 95 : 80,
      source: city ? 'city-field' : 'state-field',
    };
  }

  if (city && addressEvidence?.postalCode) {
    return {
      city,
      postalCode: addressEvidence.postalCode,
      confidence: 60,
      source: 'postal-code',
    };
  }

  return addressEvidence;
};

const isStateLevelLocalLocation = (location: NormalizedUsLocation) => {
  if (!location.stateCode) {
    return false;
  }

  if (location.mode === 'state') {
    return true;
  }

  if (location.mode !== 'local') {
    return false;
  }

  const stateName = usStateNames[location.stateCode as UsStateCode];

  if (!stateName) {
    return false;
  }

  const normalizedStateName = normalizeText(stateName);

  return (
    normalizeText(location.city) === normalizedStateName ||
    normalizeText(location.label) === normalizedStateName ||
    normalizeText(location.label) === `${normalizedStateName} ${normalizeText(location.stateCode)}`
  );
};

const isPointInsideBoundingBox = (
  point: {
    latitude?: number;
    longitude?: number;
  },
  boundingBox: NormalizedUsLocation['boundingBox'],
) => {
  const latitude = Number(point.latitude);
  const longitude = Number(point.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return false;
  }

  return (
    latitude >= boundingBox.south &&
    latitude <= boundingBox.north &&
    longitude >= boundingBox.west &&
    longitude <= boundingBox.east
  );
};

const matchesTimezoneLocation = (
  evidence: ParsedAddressEvidence | null,
  timeZoneCode: UsTimeZoneCode,
) => {
  if (!evidence?.stateCode) {
    return false;
  }

  const allowedStates = timezoneStateQueries[timeZoneCode] ?? [];
  const stateName = usStateNames[evidence.stateCode];

  return allowedStates.includes(stateName);
};

const matchesCoordinateLocation = (
  lead: LeadLocationCandidate,
  location: NormalizedUsLocation,
) => isPointInsideBoundingBox(lead, location.boundingBox);

const matchesStateLocation = (
  evidence: ParsedAddressEvidence | null,
  location: NormalizedUsLocation,
) => {
  if (!evidence?.stateCode || !location.stateCode) {
    return false;
  }

  return evidence.stateCode === location.stateCode;
};

const matchesCityStateLocation = (
  lead: LeadLocationCandidate,
  evidence: ParsedAddressEvidence | null,
  location: NormalizedUsLocation,
) => {
  if (!evidence) {
    return matchesCoordinateLocation(lead, location);
  }

  if (isStateLevelLocalLocation(location)) {
    if (evidence.stateCode) {
      return matchesStateLocation(evidence, location);
    }

    return matchesCoordinateLocation(lead, location);
  }

  if (!evidence.stateCode || !location.stateCode) {
    return matchesCoordinateLocation(lead, location);
  }

  if (evidence.stateCode !== location.stateCode) {
    return false;
  }

  const expectedCity = normalizeCity(location.city);
  const evidenceCity = normalizeCity(evidence.city);

  if (!expectedCity) {
    return true;
  }

  if (!evidenceCity) {
    return matchesCoordinateLocation(lead, location);
  }

  return evidenceCity === expectedCity;
};

const matchesRegionLocation = (
  lead: LeadLocationCandidate,
  evidence: ParsedAddressEvidence | null,
  location: NormalizedUsLocation,
) => {
  if (isPointInsideBoundingBox(lead, location.boundingBox)) {
    return true;
  }

  /**
   * Region labels like Bay Area / DMV / Tri-State usually do not map cleanly
   * from address text alone. If no coordinates exist, use state-level evidence
   * only as a soft fallback.
   */
  if (!evidence?.stateCode) {
    return false;
  }

  if (!location.stateCode) {
    return true;
  }

  return evidence.stateCode === location.stateCode;
};

export const leadMatchesLocation = (
  lead: LeadLocationCandidate,
  location: NormalizedUsLocation,
) => {
  if (location.mode === 'nationwide') {
    return true;
  }

  const evidence = parseLeadLocationEvidence(lead);

  if (location.mode === 'timezone') {
    if (!location.timeZoneCode) {
      return false;
    }

    return matchesTimezoneLocation(evidence, location.timeZoneCode);
  }

  if (location.mode === 'state') {
    if (evidence?.stateCode) {
      return matchesStateLocation(evidence, location);
    }

    return matchesCoordinateLocation(lead, location);
  }

  if (location.mode === 'region') {
    return matchesRegionLocation(lead, evidence, location);
  }

  return matchesCityStateLocation(lead, evidence, location);
};

export const filterLeadsForLocation = (
  leads: Lead[],
  location: NormalizedUsLocation,
) => leads.filter((lead) => leadMatchesLocation(lead, location));
