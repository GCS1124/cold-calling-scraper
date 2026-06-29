import type { ProviderWarning } from '../types/search';
import { httpClient } from '../utils/http-client';
import {
  normalizeUsTimeZoneQuery,
  type UsTimeZoneCode,
} from './us-timezones';

type NominatimResult = {
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  class?: string;
  importance?: number;
  place_rank?: number;
  boundingbox?: [string, string, string, string];
  addresstype?: string;
  name?: string;
  display_name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    hamlet?: string;
    suburb?: string;
    neighbourhood?: string;
    county?: string;
    state?: string;
    postcode?: string;
    country?: string;
    country_code?: string;
  };
};

const stateCodes: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
};

const stateNamesByCode = Object.fromEntries(
  Object.entries(stateCodes).map(([name, code]) => [code, name]),
) as Record<string, string>;

const stateCodesByCode = Object.fromEntries(
  Object.values(stateCodes).map((code) => [code.toLowerCase(), code]),
) as Record<string, string>;

export type NormalizedUsLocation = {
  mode: 'local' | 'nationwide' | 'timezone' | 'region' | 'state';
  label: string;
  city: string;
  stateCode: string;
  timeZoneCode?: UsTimeZoneCode;
  postalCode?: string;
  lat: number;
  lon: number;
  boundingBox: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
  warnings: ProviderWarning[];
};

type StaticLocationProfile = Omit<NormalizedUsLocation, 'warnings'> & {
  aliases: string[];
};

type ScoredMatch = {
  result: NominatimResult;
  score: number;
  reason: string;
};

const nominatimHeaders = {
  'User-Agent': 'LeadFinderPro/1.0 (US-only discovery; contact: support@leadfinderpro.local)',
};

const allowedAddressTypes = new Set([
  'city',
  'town',
  'village',
  'municipality',
  'hamlet',
  'county',
  'postcode',
  'state',
]);

const allowedCategories = new Set([
  'boundary',
  'place',
]);

const allowedTypes = new Set([
  'city',
  'town',
  'village',
  'municipality',
  'hamlet',
  'county',
  'postcode',
  'administrative',
]);

const zipPattern = /^\d{5}(?:-\d{4})?$/;

const nationwideAliases = new Set([
  'us',
  'usa',
  'u s',
  'u s a',
  'united states',
  'united states of america',
  'nationwide',
  'national',
  'all us',
  'all usa',
  'entire us',
  'entire usa',
  'all united states',
  'across us',
  'across usa',
  'across the us',
  'across the usa',
]);

const timeZoneBoundingBoxes: Record<UsTimeZoneCode, NormalizedUsLocation['boundingBox']> = {
  ET: {
    south: 24.3963,
    west: -92.0,
    north: 47.4597,
    east: -66.9346,
  },
  CT: {
    south: 25.8371,
    west: -104.0,
    north: 49.0,
    east: -82.0,
  },
  MT: {
    south: 31.3322,
    west: -115.0,
    north: 49.0,
    east: -102.0,
  },
  PT: {
    south: 32.5343,
    west: -124.8489,
    north: 49.0,
    east: -114.1315,
  },
  AKT: {
    south: 51.2,
    west: -179.1489,
    north: 71.5,
    east: -129.9795,
  },
  HAT: {
    south: 18.87,
    west: -160.25,
    north: 22.29,
    east: -154.82,
  },
};

const nationwideBoundingBox = {
  south: 24.3963,
  west: -125,
  north: 49.3845,
  east: -66.9346,
};

const stateNames = new Set(Object.keys(stateCodes));
const stateAbbreviations = new Set(Object.values(stateCodes).map((value) => value.toLowerCase()));

const staticLocationProfiles: StaticLocationProfile[] = [
  {
    mode: 'region',
    label: 'New York City, NY',
    city: 'New York City',
    stateCode: 'NY',
    lat: 40.7128,
    lon: -74.006,
    boundingBox: {
      south: 40.4774,
      west: -74.2591,
      north: 40.9176,
      east: -73.7004,
    },
    aliases: ['nyc', 'new york city', 'new york ny', 'new york, ny'],
  },
  {
    mode: 'region',
    label: 'Los Angeles, CA',
    city: 'Los Angeles',
    stateCode: 'CA',
    lat: 34.0522,
    lon: -118.2437,
    boundingBox: {
      south: 33.7037,
      west: -118.6682,
      north: 34.3373,
      east: -118.1553,
    },
    aliases: ['la', 'l a', 'los angeles', 'los angeles ca', 'los angeles, ca'],
  },
  {
    mode: 'region',
    label: 'San Francisco, CA',
    city: 'San Francisco',
    stateCode: 'CA',
    lat: 37.7749,
    lon: -122.4194,
    boundingBox: {
      south: 37.6398,
      west: -123.1738,
      north: 37.9298,
      east: -122.2818,
    },
    aliases: ['sf', 'san francisco', 'san francisco ca', 'san francisco, ca'],
  },
  {
    mode: 'region',
    label: 'Washington, DC',
    city: 'Washington',
    stateCode: 'DC',
    lat: 38.9072,
    lon: -77.0369,
    boundingBox: {
      south: 38.7916,
      west: -77.1198,
      north: 38.9955,
      east: -76.9094,
    },
    aliases: ['dc', 'd c', 'washington dc', 'washington, dc', 'district of columbia'],
  },
  {
    mode: 'region',
    label: 'Bay Area, CA',
    city: 'Bay Area',
    stateCode: 'CA',
    lat: 37.8272,
    lon: -122.2913,
    boundingBox: {
      south: 36.8933,
      west: -123.1738,
      north: 38.8642,
      east: -121.2082,
    },
    aliases: [
      'bay area',
      'sf bay area',
      'san francisco bay area',
      'silicon valley',
      'bay area ca',
      'bay area, ca',
    ],
  },
  {
    mode: 'region',
    label: 'Southern California',
    city: 'Southern California',
    stateCode: 'CA',
    lat: 34.0,
    lon: -117.5,
    boundingBox: {
      south: 32.5343,
      west: -121.0,
      north: 36.5,
      east: -114.1315,
    },
    aliases: ['socal', 'southern california', 'south california'],
  },
  {
    mode: 'region',
    label: 'Northern California',
    city: 'Northern California',
    stateCode: 'CA',
    lat: 39.0,
    lon: -121.5,
    boundingBox: {
      south: 36.5,
      west: -124.482,
      north: 42.0095,
      east: -118.0,
    },
    aliases: ['norcal', 'northern california', 'north california'],
  },
  {
    mode: 'region',
    label: 'DMV Area',
    city: 'DMV Area',
    stateCode: '',
    lat: 38.9072,
    lon: -77.0369,
    boundingBox: {
      south: 38.0,
      west: -78.6,
      north: 39.7,
      east: -76.0,
    },
    aliases: [
      'dmv',
      'dmv area',
      'dc maryland virginia',
      'washington metro area',
      'washington metropolitan area',
    ],
  },
  {
    mode: 'region',
    label: 'Tri-State Area',
    city: 'Tri-State Area',
    stateCode: '',
    lat: 40.75,
    lon: -74.0,
    boundingBox: {
      south: 39.5,
      west: -75.8,
      north: 42.1,
      east: -71.7,
    },
    aliases: [
      'tri state',
      'tri state area',
      'tristate',
      'tristate area',
      'ny nj ct',
      'new york metropolitan area',
    ],
  },
];

const normalizeText = (value: string) => {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\./g, ' ')
    .replace(/[-_/]/g, ' ')
    .replace(/[^\w\s,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const normalizeComparableText = (value: string) => {
  return normalizeText(value)
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const tokenize = (value: string) =>
  normalizeComparableText(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter(Boolean);

const cleanZip = (value: string) => {
  const match = value.trim().match(/\b\d{5}(?:-\d{4})?\b/);
  return match?.[0];
};

const isZipQuery = (rawLocation: string) => {
  return zipPattern.test(rawLocation.trim());
};

const toStateCode = (state?: string) => {
  if (!state) {
    return '';
  }

  const normalized = normalizeComparableText(state);
  return stateCodes[normalized] ?? stateCodesByCode[normalized] ?? state.trim().toUpperCase();
};

const toStateName = (stateCode: string) => {
  const normalized = stateCode.trim().toUpperCase();
  const stateName = stateNamesByCode[normalized];

  if (!stateName) return '';

  return stateName
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const isNationwideQuery = (rawLocation: string) =>
  nationwideAliases.has(normalizeComparableText(rawLocation));

const isStateQuery = (rawLocation: string) => {
  const normalized = normalizeComparableText(rawLocation);
  return stateNames.has(normalized) || stateAbbreviations.has(normalized);
};

const getStaticLocationProfile = (rawLocation: string) => {
  const normalized = normalizeComparableText(rawLocation);

  return staticLocationProfiles.find((profile) =>
    profile.aliases.some((alias) => normalizeComparableText(alias) === normalized),
  );
};

const toBoundingBox = (bbox?: [string, string, string, string]) => {
  if (!bbox?.length) {
    return null;
  }

  const [southRaw, northRaw, westRaw, eastRaw] = bbox.map(Number);

  const boundingBox = {
    south: southRaw,
    west: westRaw,
    north: northRaw,
    east: eastRaw,
  };

  if (!isValidBoundingBox(boundingBox)) {
    return null;
  }

  return boundingBox;
};

const isValidBoundingBox = (boundingBox?: NormalizedUsLocation['boundingBox'] | null) => {
  if (!boundingBox) return false;

  const values = [
    boundingBox.south,
    boundingBox.west,
    boundingBox.north,
    boundingBox.east,
  ];

  if (values.some((value) => !Number.isFinite(value))) {
    return false;
  }

  if (boundingBox.south >= boundingBox.north) {
    return false;
  }

  if (boundingBox.west >= boundingBox.east) {
    return false;
  }

  return true;
};

const buildPointBoundingBox = (
  lat: number,
  lon: number,
  radiusDegrees = 0.25,
): NormalizedUsLocation['boundingBox'] => {
  return {
    south: lat - radiusDegrees,
    west: lon - radiusDegrees,
    north: lat + radiusDegrees,
    east: lon + radiusDegrees,
  };
};

const isUsResult = (result: NominatimResult) => {
  return result.address?.country_code?.toLowerCase() === 'us';
};

const getResultCity = (result: NominatimResult) => {
  return (
    result.address?.city ??
    result.address?.town ??
    result.address?.village ??
    result.address?.municipality ??
    result.address?.hamlet ??
    result.address?.county ??
    result.name ??
    ''
  ).trim();
};

const getResultStateCode = (result: NominatimResult) => {
  return toStateCode(result.address?.state);
};

const getResultPostalCode = (result: NominatimResult) => {
  return result.address?.postcode?.trim();
};

const hasAllowedNominatimShape = (result: NominatimResult) => {
  const addressType = result.addresstype ?? '';
  const category = result.category ?? result.class ?? '';
  const type = result.type ?? '';

  if (!allowedAddressTypes.has(addressType)) {
    return false;
  }

  if (!allowedCategories.has(category)) {
    return false;
  }

  if (type && !allowedTypes.has(type)) {
    return false;
  }

  return true;
};

const parseCityStateInput = (rawLocation: string) => {
  const trimmed = rawLocation.trim().replace(/\s+/g, ' ');

  const commaMatch = trimmed.match(/^(.+?),\s*([A-Za-z]{2}|[A-Za-z][A-Za-z.\s'-]+)$/);
  if (commaMatch) {
    return {
      city: commaMatch[1].trim(),
      stateCode: toStateCode(commaMatch[2]),
    };
  }

  const tokens = trimmed.split(/\s+/);
  const possibleState = tokens[tokens.length - 1];

  if (possibleState && stateAbbreviations.has(possibleState.toLowerCase())) {
    return {
      city: tokens.slice(0, -1).join(' ').trim(),
      stateCode: possibleState.toUpperCase(),
    };
  }

  return null;
};

const isAcceptableMatch = (rawLocation: string, result: NominatimResult) => {
  if (!isUsResult(result)) {
    return false;
  }

  if (!hasAllowedNominatimShape(result)) {
    return false;
  }

  const input = rawLocation.trim();
  const zip = cleanZip(input);

  if (zip && isZipQuery(input)) {
    return (
      result.addresstype === 'postcode' &&
      Boolean(result.address?.postcode?.startsWith(zip.slice(0, 5)))
    );
  }

  const parsedCityState = parseCityStateInput(input);
  const inputTokens = tokenize(input);

  const resultCity = getResultCity(result);
  const cityTokens = tokenize(resultCity);
  const stateTokens = tokenize(result.address?.state ?? '');
  const stateCode = getResultStateCode(result).toLowerCase();

  if (parsedCityState?.stateCode) {
    const expectedStateCode = parsedCityState.stateCode.toLowerCase();
    const actualStateCode = getResultStateCode(result).toLowerCase();

    if (expectedStateCode !== actualStateCode) {
      return false;
    }
  }

  if (isStateQuery(input)) {
    return result.addresstype === 'state';
  }

  const nonStateTokens = inputTokens.filter(
    (token) =>
      token !== 'us' &&
      token !== 'usa' &&
      token !== stateCode &&
      !stateTokens.includes(token),
  );

  if (!nonStateTokens.length) {
    return true;
  }

  return nonStateTokens.every((token) => cityTokens.includes(token));
};

const scoreMatch = (rawLocation: string, result: NominatimResult): ScoredMatch => {
  let score = 0;
  const reasons: string[] = [];

  const input = rawLocation.trim();
  const normalizedInput = normalizeComparableText(input);
  const resultCity = getResultCity(result);
  const normalizedCity = normalizeComparableText(resultCity);
  const resultStateCode = getResultStateCode(result);
  const parsedCityState = parseCityStateInput(input);
  const zip = cleanZip(input);

  if (isUsResult(result)) {
    score += 50;
    reasons.push('US result');
  }

  if (hasAllowedNominatimShape(result)) {
    score += 30;
    reasons.push('allowed result shape');
  }

  if (zip && result.address?.postcode?.startsWith(zip.slice(0, 5))) {
    score += 100;
    reasons.push('ZIP match');
  }

  if (normalizedInput === normalizedCity) {
    score += 80;
    reasons.push('exact city match');
  }

  if (normalizedInput.includes(normalizedCity) || normalizedCity.includes(normalizedInput)) {
    score += 30;
    reasons.push('partial city match');
  }

  if (parsedCityState?.city) {
    const normalizedParsedCity = normalizeComparableText(parsedCityState.city);

    if (normalizedParsedCity === normalizedCity) {
      score += 80;
      reasons.push('exact parsed city match');
    }

    if (parsedCityState.stateCode === resultStateCode) {
      score += 80;
      reasons.push('state code match');
    } else if (parsedCityState.stateCode && resultStateCode) {
      score -= 120;
      reasons.push('state code mismatch');
    }
  }

  if (isStateQuery(input) && result.addresstype === 'state') {
    score += 100;
    reasons.push('state query resolved as state');
  }

  if (result.addresstype === 'city') {
    score += 25;
    reasons.push('city address type');
  }

  if (result.addresstype === 'postcode') {
    score += 20;
    reasons.push('postcode address type');
  }

  if (result.addresstype === 'county') {
    score += 10;
    reasons.push('county address type');
  }

  if (typeof result.importance === 'number') {
    score += result.importance * 10;
    reasons.push('importance boost');
  }

  if (typeof result.place_rank === 'number') {
    score += Math.max(0, 30 - result.place_rank);
    reasons.push('place rank boost');
  }

  return {
    result,
    score,
    reason: reasons.join(', '),
  };
};

const pickBestMatch = (rawLocation: string, results: NominatimResult[]) => {
  const scored = results
    .filter((result) => isAcceptableMatch(rawLocation, result))
    .map((result) => scoreMatch(rawLocation, result))
    .sort((a, b) => b.score - a.score);

  return scored;
};

const toLocationLabel = (result: NominatimResult) => {
  const city = getResultCity(result);
  const stateName = result.address?.state ?? result.name ?? '';
  const stateCode = getResultStateCode(result);
  const postalCode = getResultPostalCode(result);

  if (result.addresstype === 'postcode' && postalCode) {
    const cityForZip = city || stateName;
    return {
      city: cityForZip,
      stateCode,
      label: stateCode ? `${postalCode}, ${stateCode}` : postalCode,
    };
  }

  if (result.addresstype === 'state') {
    return {
      city: stateName,
      stateCode,
      label: stateName || stateCode,
    };
  }

  return {
    city: city || stateName,
    stateCode,
    label: city && stateCode ? `${city}, ${stateCode}` : city || stateName,
  };
};

const getStateFallbackBoundingBox = (stateCode: string) => {
  const stateName = toStateName(stateCode);
  if (!stateName) return null;

  return null;
};

const buildFallbackLocation = (
  rawLocation: string,
  error: unknown,
): NormalizedUsLocation => {
  const trimmed = rawLocation.trim().replace(/\s+/g, ' ');
  const parsedCityState = parseCityStateInput(trimmed);
  const zip = cleanZip(trimmed);

  const city = parsedCityState?.city || trimmed;
  const stateCode = parsedCityState?.stateCode || '';
  const stateName = toStateName(stateCode);
  const label =
    zip && stateCode
      ? `${zip}, ${stateCode}`
      : parsedCityState?.city && stateCode
        ? `${parsedCityState.city}, ${stateCode}`
        : stateName
          ? `${stateName}, ${stateCode}`
          : trimmed || 'Unknown Location';

  return {
    mode: isStateQuery(trimmed) ? 'state' : 'local',
    label,
    city: parsedCityState?.city || stateName || trimmed,
    stateCode,
    postalCode: zip,
    lat: 39.8283,
    lon: -98.5795,
    boundingBox: getStateFallbackBoundingBox(stateCode) ?? nationwideBoundingBox,
    warnings: [
      {
        providerId: 'nominatim',
        providerName: 'Nominatim',
        message:
          error instanceof Error
            ? `${error.message} while normalizing "${trimmed}". Using a coarse fallback.`
            : `Unable to normalize "${trimmed}". Using a coarse fallback.`,
      },
    ],
  };
};

const buildNominatimQueryCandidates = (rawLocation: string) => {
  const trimmed = rawLocation.trim().replace(/\s+/g, ' ');
  const normalized = normalizeComparableText(trimmed);
  const candidates = new Set<string>();

  candidates.add(trimmed);

  const parsedCityState = parseCityStateInput(trimmed);
  if (parsedCityState?.city && parsedCityState.stateCode) {
    const stateName = toStateName(parsedCityState.stateCode);

    candidates.add(`${parsedCityState.city}, ${parsedCityState.stateCode}`);
    if (stateName) {
      candidates.add(`${parsedCityState.city}, ${stateName}`);
    }
    candidates.add(`${parsedCityState.city}, ${parsedCityState.stateCode}, USA`);
  }

  const zip = cleanZip(trimmed);
  if (zip) {
    candidates.add(zip);
    candidates.add(`${zip}, USA`);
  }

  if (stateNames.has(normalized)) {
    candidates.add(`${trimmed}, USA`);
  }

  if (stateAbbreviations.has(normalized)) {
    const stateName = toStateName(normalized.toUpperCase());
    if (stateName) {
      candidates.add(`${stateName}, USA`);
    }
  }

  return [...candidates].filter(Boolean);
};

const fetchNominatimResults = async (rawLocation: string) => {
  const candidates = buildNominatimQueryCandidates(rawLocation);
  const allResults: NominatimResult[] = [];

  for (const candidate of candidates) {
    const queryParams: Record<string, string | number> = {
      q: candidate,
      format: 'jsonv2',
      addressdetails: 1,
      limit: 8,
      countrycodes: 'us',
    };

    if (isStateQuery(candidate)) {
      queryParams.featuretype = 'state';
    }

    const response = await httpClient.get<NominatimResult[]>(
      'https://nominatim.openstreetmap.org/search',
      {
        params: queryParams,
        headers: nominatimHeaders,
        timeout: 8000,
      },
    );

    allResults.push(...response.data);

    const strongMatches = pickBestMatch(rawLocation, response.data);
    if (strongMatches[0]?.score >= 180) {
      break;
    }
  }

  const deduped = new Map<string, NominatimResult>();

  for (const result of allResults) {
    const key = [
      result.lat,
      result.lon,
      result.addresstype,
      result.name,
      result.address?.postcode,
    ].join('|');

    deduped.set(key, result);
  }

  return [...deduped.values()];
};

export const normalizeUsLocation = async (
  rawLocation: string,
): Promise<NormalizedUsLocation> => {
  const cleaned = rawLocation.trim();

  if (!cleaned) {
    return {
      mode: 'local',
      label: 'Unknown Location',
      city: '',
      stateCode: '',
      postalCode: undefined,
      lat: 39.8283,
      lon: -98.5795,
      boundingBox: nationwideBoundingBox,
      warnings: [
        {
          providerId: 'location-normalizer',
          providerName: 'Location Normalizer',
          message: 'No location was provided. Using nationwide fallback.',
        },
      ],
    };
  }

  const staticLocation = getStaticLocationProfile(cleaned);
  if (staticLocation) {
    return {
      ...staticLocation,
      warnings: [
        {
          providerId: 'location-normalizer',
          providerName: 'Location Normalizer',
          message: `Resolved "${cleaned}" using a built-in regional alias.`,
        },
      ],
    };
  }

  const timeZone = isStateQuery(cleaned) ? null : normalizeUsTimeZoneQuery(cleaned);
  if (timeZone) {
    return {
      mode: 'timezone',
      label: timeZone.label,
      city: timeZone.label,
      stateCode: '',
      timeZoneCode: timeZone.code,
      postalCode: undefined,
      lat: 39.8283,
      lon: -98.5795,
      boundingBox: timeZoneBoundingBoxes[timeZone.code],
      warnings: [],
    };
  }

  if (isNationwideQuery(cleaned)) {
    return {
      mode: 'nationwide',
      label: 'United States',
      city: '',
      stateCode: '',
      postalCode: undefined,
      lat: 39.8283,
      lon: -98.5795,
      boundingBox: nationwideBoundingBox,
      warnings: [],
    };
  }

  let results: NominatimResult[];

  try {
    results = await fetchNominatimResults(cleaned);
  } catch (error) {
    return buildFallbackLocation(cleaned, error);
  }

  const scoredMatches = pickBestMatch(cleaned, results);

  if (!scoredMatches.length) {
    throw new Error('No US location match found');
  }

  const best = scoredMatches[0];
  const secondBest = scoredMatches[1];

  const primary = best.result;
  const canonical = toLocationLabel(primary);

  const lat = Number(primary.lat);
  const lon = Number(primary.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return buildFallbackLocation(cleaned, new Error('Resolved location has invalid coordinates'));
  }

  const boundingBox =
    toBoundingBox(primary.boundingbox) ??
    buildPointBoundingBox(lat, lon, primary.addresstype === 'postcode' ? 0.08 : 0.25);

  if (!canonical.city || !canonical.stateCode || !isValidBoundingBox(boundingBox)) {
    return buildFallbackLocation(
      cleaned,
      new Error('Location could not be normalized to a usable US city, state, county, or ZIP'),
    );
  }

  const warnings: ProviderWarning[] = [];

  if (secondBest && best.score - secondBest.score < 25) {
    warnings.push({
      providerId: 'nominatim',
      providerName: 'Nominatim',
      message: `Resolved "${cleaned}" to ${canonical.label}, but multiple close US matches were found.`,
    });
  }

  if (best.score < 130) {
    warnings.push({
      providerId: 'nominatim',
      providerName: 'Nominatim',
      message: `Resolved "${cleaned}" to ${canonical.label} with low confidence. Search coverage may be broad.`,
    });
  }

  return {
    mode: 'local',
    label: canonical.label,
    city: canonical.city,
    stateCode: canonical.stateCode,
    postalCode: getResultPostalCode(primary),
    lat,
    lon,
    boundingBox,
    warnings,
  };
};
