import type { ProviderWarning } from '../types/search';
import { httpClient } from '../utils/http-client';

type NominatimResult = {
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  boundingbox?: [string, string, string, string];
  addresstype?: string;
  name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    hamlet?: string;
    county?: string;
    state?: string;
    postcode?: string;
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

export type NormalizedUsLocation = {
  mode: 'local' | 'nationwide';
  label: string;
  city: string;
  stateCode: string;
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

const nominatimHeaders = {
  'User-Agent': 'LeadFinderPro/1.0 (US-only discovery)',
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

const allowedCategories = new Set(['boundary', 'place']);

const zipPattern = /^\d{5}(?:-\d{4})?$/;
const nationwideAliases = new Set([
  'us',
  'usa',
  'u.s.',
  'u.s.a.',
  'united states',
  'united states of america',
  'nationwide',
  'all us',
  'all usa',
  'entire us',
  'entire usa',
]);

const nationwideBoundingBox = {
  south: 24.3963,
  west: -125,
  north: 49.3845,
  east: -66.9346,
};

const stateNames = new Set(Object.keys(stateCodes));
const stateAbbreviations = new Set(Object.values(stateCodes).map((value) => value.toLowerCase()));

const toStateCode = (state?: string) => {
  if (!state) {
    return '';
  }

  const normalized = state.trim().toLowerCase();
  return stateCodes[normalized] ?? state.trim().toUpperCase();
};

const toLocationLabel = (result: NominatimResult) => {
  const city =
    result.address?.city ??
    result.address?.town ??
    result.address?.village ??
    result.address?.municipality ??
    result.address?.hamlet ??
    result.address?.county;
  const stateName = result.address?.state ?? result.name ?? '';
  const stateCode = toStateCode(result.address?.state);
  const resolvedCity = city?.trim() || stateName.trim();

  return {
    city: resolvedCity,
    stateCode,
    label:
      city?.trim() && stateCode
        ? [city.trim(), stateCode].join(', ')
        : resolvedCity,
  };
};

const isNationwideQuery = (rawLocation: string) =>
  nationwideAliases.has(rawLocation.trim().toLowerCase());

const isStateQuery = (rawLocation: string) => {
  const normalized = rawLocation.trim().toLowerCase();
  return stateNames.has(normalized) || stateAbbreviations.has(normalized);
};

const toBoundingBox = (bbox?: [string, string, string, string]) => {
  if (!bbox?.length) {
    return null;
  }

  const [south, north, west, east] = bbox.map(Number);
  return { south, west, north, east };
};

const tokenize = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter(Boolean);

const isAcceptableMatch = (rawLocation: string, result: NominatimResult) => {
  if (
    !allowedAddressTypes.has(result.addresstype ?? '') ||
    !allowedCategories.has(result.category ?? '')
  ) {
    return false;
  }

  const input = rawLocation.trim();
  if (zipPattern.test(input)) {
    return result.addresstype === 'postcode' && result.address?.postcode?.startsWith(input);
  }

  const inputTokens = tokenize(input);
  const cityTokens = tokenize(
    result.address?.city ??
      result.address?.town ??
      result.address?.village ??
      result.address?.municipality ??
      result.address?.hamlet ??
      result.address?.county ??
      result.name ??
      '',
  );

  const stateTokens = tokenize(result.address?.state ?? '');
  const stateCode = toStateCode(result.address?.state).toLowerCase();

  const nonStateTokens = inputTokens.filter((token) => token !== 'us' && token !== 'usa');
  const requiredLocationTokens = nonStateTokens.filter(
    (token) => token !== stateCode && !stateTokens.includes(token),
  );

  return requiredLocationTokens.every((token) => cityTokens.includes(token));
};

export const normalizeUsLocation = async (
  rawLocation: string,
): Promise<NormalizedUsLocation> => {
  if (isNationwideQuery(rawLocation)) {
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

  const queryParams: Record<string, string | number> = {
    q: rawLocation,
    format: 'jsonv2',
    addressdetails: 1,
    limit: 5,
    countrycodes: 'us',
  };

  if (isStateQuery(rawLocation)) {
    queryParams.featuretype = 'state';
  }

  const response = await httpClient.get<NominatimResult[]>(
    'https://nominatim.openstreetmap.org/search',
    {
      params: queryParams,
      headers: nominatimHeaders,
      timeout: 6000,
    },
  );

  const matches = response.data.filter(
    (result) =>
      result.address?.country_code?.toLowerCase() === 'us' &&
      isAcceptableMatch(rawLocation, result),
  );

  if (!matches.length) {
    throw new Error('No US location match found');
  }

  const primary = matches[0];
  const canonical = toLocationLabel(primary);
  const boundingBox = toBoundingBox(primary.boundingbox);

  if (!canonical.city || !canonical.stateCode || !boundingBox) {
    throw new Error('Location could not be normalized to a US city or ZIP');
  }

  const warnings: ProviderWarning[] = [];

  if (matches.length > 1) {
    warnings.push({
      providerId: 'nominatim',
      providerName: 'Nominatim',
      message: `Resolved "${rawLocation}" to ${canonical.label} from multiple US matches.`,
    });
  }

  return {
    mode: 'local',
    label: canonical.label,
    city: canonical.city,
    stateCode: canonical.stateCode,
    postalCode: primary.address?.postcode,
    lat: Number(primary.lat),
    lon: Number(primary.lon),
    boundingBox,
    warnings,
  };
};
