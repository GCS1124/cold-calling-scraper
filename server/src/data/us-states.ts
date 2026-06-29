export const usStateCodes = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

export type UsStateCode = (typeof usStateCodes)[number];

export type UsRegion =
  | 'west'
  | 'southwest'
  | 'midwest'
  | 'south'
  | 'southeast'
  | 'northeast'
  | 'midAtlantic'
  | 'pacific'
  | 'nonContiguous';

export type UsTimeZoneGroup =
  | 'ET'
  | 'CT'
  | 'MT'
  | 'PT'
  | 'AKT'
  | 'HAT'
  | 'MULTI';

export type UsBoundingBox = {
  south: number;
  west: number;
  north: number;
  east: number;
};

export type UsStateProfile = {
  code: UsStateCode;
  name: string;
  slug: string;
  aliases: string[];
  nominatimQuery: string;
  region: UsRegion;
  timeZoneGroup: UsTimeZoneGroup;
  populationPriority: number;
  boundingBox: UsBoundingBox;
  isDistrict?: boolean;
  isNonContiguous?: boolean;
};

const normalizeStateInput = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toSlug = (value: string) =>
  normalizeStateInput(value).replace(/\s+/g, '-');

export const usStateProfiles = [
  {
    code: 'AL',
    name: 'Alabama',
    slug: 'alabama',
    aliases: ['alabama', 'al'],
    nominatimQuery: 'Alabama, USA',
    region: 'southeast',
    timeZoneGroup: 'CT',
    populationPriority: 24,
    boundingBox: { south: 30.2233, west: -88.4732, north: 35.008, east: -84.8891 },
  },
  {
    code: 'AK',
    name: 'Alaska',
    slug: 'alaska',
    aliases: ['alaska', 'ak'],
    nominatimQuery: 'Alaska, USA',
    region: 'nonContiguous',
    timeZoneGroup: 'AKT',
    populationPriority: 48,
    boundingBox: { south: 51.2142, west: -179.1489, north: 71.3652, east: -129.9795 },
    isNonContiguous: true,
  },
  {
    code: 'AZ',
    name: 'Arizona',
    slug: 'arizona',
    aliases: ['arizona', 'az'],
    nominatimQuery: 'Arizona, USA',
    region: 'southwest',
    timeZoneGroup: 'MT',
    populationPriority: 14,
    boundingBox: { south: 31.3322, west: -114.8183, north: 37.0043, east: -109.0452 },
  },
  {
    code: 'AR',
    name: 'Arkansas',
    slug: 'arkansas',
    aliases: ['arkansas', 'ar'],
    nominatimQuery: 'Arkansas, USA',
    region: 'south',
    timeZoneGroup: 'CT',
    populationPriority: 33,
    boundingBox: { south: 33.0041, west: -94.6179, north: 36.4996, east: -89.6444 },
  },
  {
    code: 'CA',
    name: 'California',
    slug: 'california',
    aliases: ['california', 'ca', 'cali'],
    nominatimQuery: 'California, USA',
    region: 'west',
    timeZoneGroup: 'PT',
    populationPriority: 1,
    boundingBox: { south: 32.5343, west: -124.4096, north: 42.0095, east: -114.1315 },
  },
  {
    code: 'CO',
    name: 'Colorado',
    slug: 'colorado',
    aliases: ['colorado', 'co'],
    nominatimQuery: 'Colorado, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 21,
    boundingBox: { south: 36.9924, west: -109.0603, north: 41.0034, east: -102.0416 },
  },
  {
    code: 'CT',
    name: 'Connecticut',
    slug: 'connecticut',
    aliases: ['connecticut', 'ct'],
    nominatimQuery: 'Connecticut, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 29,
    boundingBox: { south: 40.9801, west: -73.7278, north: 42.0506, east: -71.7869 },
  },
  {
    code: 'DE',
    name: 'Delaware',
    slug: 'delaware',
    aliases: ['delaware', 'de'],
    nominatimQuery: 'Delaware, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 45,
    boundingBox: { south: 38.451, west: -75.789, north: 39.839, east: -75.0489 },
  },
  {
    code: 'DC',
    name: 'District of Columbia',
    slug: 'district-of-columbia',
    aliases: ['district of columbia', 'dc', 'd c', 'washington dc', 'washington, dc'],
    nominatimQuery: 'District of Columbia, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 51,
    boundingBox: { south: 38.7916, west: -77.1198, north: 38.9955, east: -76.9094 },
    isDistrict: true,
  },
  {
    code: 'FL',
    name: 'Florida',
    slug: 'florida',
    aliases: ['florida', 'fl'],
    nominatimQuery: 'Florida, USA',
    region: 'southeast',
    timeZoneGroup: 'MULTI',
    populationPriority: 3,
    boundingBox: { south: 24.3963, west: -87.6349, north: 31.0009, east: -80.0314 },
  },
  {
    code: 'GA',
    name: 'Georgia',
    slug: 'georgia',
    aliases: ['georgia', 'ga'],
    nominatimQuery: 'Georgia, USA',
    region: 'southeast',
    timeZoneGroup: 'ET',
    populationPriority: 8,
    boundingBox: { south: 30.3556, west: -85.6052, north: 35.0007, east: -80.7514 },
  },
  {
    code: 'HI',
    name: 'Hawaii',
    slug: 'hawaii',
    aliases: ['hawaii', 'hi'],
    nominatimQuery: 'Hawaii, USA',
    region: 'nonContiguous',
    timeZoneGroup: 'HAT',
    populationPriority: 40,
    boundingBox: { south: 18.87, west: -160.25, north: 22.29, east: -154.82 },
    isNonContiguous: true,
  },
  {
    code: 'ID',
    name: 'Idaho',
    slug: 'idaho',
    aliases: ['idaho', 'id'],
    nominatimQuery: 'Idaho, USA',
    region: 'west',
    timeZoneGroup: 'MULTI',
    populationPriority: 39,
    boundingBox: { south: 42.0, west: -117.243, north: 49.0011, east: -111.0436 },
  },
  {
    code: 'IL',
    name: 'Illinois',
    slug: 'illinois',
    aliases: ['illinois', 'il'],
    nominatimQuery: 'Illinois, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 6,
    boundingBox: { south: 36.9701, west: -91.5131, north: 42.5083, east: -87.4952 },
  },
  {
    code: 'IN',
    name: 'Indiana',
    slug: 'indiana',
    aliases: ['indiana', 'in'],
    nominatimQuery: 'Indiana, USA',
    region: 'midwest',
    timeZoneGroup: 'MULTI',
    populationPriority: 17,
    boundingBox: { south: 37.7717, west: -88.0979, north: 41.7614, east: -84.7846 },
  },
  {
    code: 'IA',
    name: 'Iowa',
    slug: 'iowa',
    aliases: ['iowa', 'ia'],
    nominatimQuery: 'Iowa, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 30,
    boundingBox: { south: 40.3754, west: -96.6397, north: 43.5012, east: -90.1401 },
  },
  {
    code: 'KS',
    name: 'Kansas',
    slug: 'kansas',
    aliases: ['kansas', 'ks'],
    nominatimQuery: 'Kansas, USA',
    region: 'midwest',
    timeZoneGroup: 'MULTI',
    populationPriority: 35,
    boundingBox: { south: 36.9931, west: -102.0517, north: 40.0031, east: -94.5884 },
  },
  {
    code: 'KY',
    name: 'Kentucky',
    slug: 'kentucky',
    aliases: ['kentucky', 'ky'],
    nominatimQuery: 'Kentucky, USA',
    region: 'south',
    timeZoneGroup: 'MULTI',
    populationPriority: 26,
    boundingBox: { south: 36.4967, west: -89.5715, north: 39.1475, east: -81.9645 },
  },
  {
    code: 'LA',
    name: 'Louisiana',
    slug: 'louisiana',
    aliases: ['louisiana', 'la'],
    nominatimQuery: 'Louisiana, USA',
    region: 'south',
    timeZoneGroup: 'CT',
    populationPriority: 25,
    boundingBox: { south: 28.9286, west: -94.043, north: 33.0195, east: -88.817 },
  },
  {
    code: 'ME',
    name: 'Maine',
    slug: 'maine',
    aliases: ['maine', 'me'],
    nominatimQuery: 'Maine, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 42,
    boundingBox: { south: 42.9777, west: -71.0839, north: 47.4597, east: -66.9499 },
  },
  {
    code: 'MD',
    name: 'Maryland',
    slug: 'maryland',
    aliases: ['maryland', 'md'],
    nominatimQuery: 'Maryland, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 19,
    boundingBox: { south: 37.9117, west: -79.4877, north: 39.723, east: -75.0489 },
  },
  {
    code: 'MA',
    name: 'Massachusetts',
    slug: 'massachusetts',
    aliases: ['massachusetts', 'ma'],
    nominatimQuery: 'Massachusetts, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 15,
    boundingBox: { south: 41.237, west: -73.5081, north: 42.8868, east: -69.9283 },
  },
  {
    code: 'MI',
    name: 'Michigan',
    slug: 'michigan',
    aliases: ['michigan', 'mi'],
    nominatimQuery: 'Michigan, USA',
    region: 'midwest',
    timeZoneGroup: 'MULTI',
    populationPriority: 10,
    boundingBox: { south: 41.6961, west: -90.4181, north: 48.3061, east: -82.1228 },
  },
  {
    code: 'MN',
    name: 'Minnesota',
    slug: 'minnesota',
    aliases: ['minnesota', 'mn'],
    nominatimQuery: 'Minnesota, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 22,
    boundingBox: { south: 43.4994, west: -97.2393, north: 49.3845, east: -89.4919 },
  },
  {
    code: 'MS',
    name: 'Mississippi',
    slug: 'mississippi',
    aliases: ['mississippi', 'ms'],
    nominatimQuery: 'Mississippi, USA',
    region: 'southeast',
    timeZoneGroup: 'CT',
    populationPriority: 34,
    boundingBox: { south: 30.1739, west: -91.655, north: 34.9961, east: -88.0979 },
  },
  {
    code: 'MO',
    name: 'Missouri',
    slug: 'missouri',
    aliases: ['missouri', 'mo'],
    nominatimQuery: 'Missouri, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 18,
    boundingBox: { south: 35.9957, west: -95.7741, north: 40.6136, east: -89.0988 },
  },
  {
    code: 'MT',
    name: 'Montana',
    slug: 'montana',
    aliases: ['montana', 'mt'],
    nominatimQuery: 'Montana, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 44,
    boundingBox: { south: 44.3582, west: -116.050, north: 49.0011, east: -104.0394 },
  },
  {
    code: 'NE',
    name: 'Nebraska',
    slug: 'nebraska',
    aliases: ['nebraska', 'ne'],
    nominatimQuery: 'Nebraska, USA',
    region: 'midwest',
    timeZoneGroup: 'MULTI',
    populationPriority: 37,
    boundingBox: { south: 39.9999, west: -104.0535, north: 43.0017, east: -95.3083 },
  },
  {
    code: 'NV',
    name: 'Nevada',
    slug: 'nevada',
    aliases: ['nevada', 'nv'],
    nominatimQuery: 'Nevada, USA',
    region: 'west',
    timeZoneGroup: 'MULTI',
    populationPriority: 32,
    boundingBox: { south: 35.0019, west: -120.0065, north: 42.0022, east: -114.0396 },
  },
  {
    code: 'NH',
    name: 'New Hampshire',
    slug: 'new-hampshire',
    aliases: ['new hampshire', 'nh'],
    nominatimQuery: 'New Hampshire, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 41,
    boundingBox: { south: 42.697, west: -72.5572, north: 45.3058, east: -70.6106 },
  },
  {
    code: 'NJ',
    name: 'New Jersey',
    slug: 'new-jersey',
    aliases: ['new jersey', 'nj'],
    nominatimQuery: 'New Jersey, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 11,
    boundingBox: { south: 38.9285, west: -75.5596, north: 41.3576, east: -73.9025 },
  },
  {
    code: 'NM',
    name: 'New Mexico',
    slug: 'new-mexico',
    aliases: ['new mexico', 'nm'],
    nominatimQuery: 'New Mexico, USA',
    region: 'southwest',
    timeZoneGroup: 'MT',
    populationPriority: 36,
    boundingBox: { south: 31.3323, west: -109.0502, north: 37.0003, east: -103.0022 },
  },
  {
    code: 'NY',
    name: 'New York',
    slug: 'new-york',
    aliases: ['new york', 'ny', 'new york state', 'nys'],
    nominatimQuery: 'New York State, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 4,
    boundingBox: { south: 40.4774, west: -79.7624, north: 45.0159, east: -71.8562 },
  },
  {
    code: 'NC',
    name: 'North Carolina',
    slug: 'north-carolina',
    aliases: ['north carolina', 'nc'],
    nominatimQuery: 'North Carolina, USA',
    region: 'southeast',
    timeZoneGroup: 'ET',
    populationPriority: 9,
    boundingBox: { south: 33.8423, west: -84.3219, north: 36.5881, east: -75.4606 },
  },
  {
    code: 'ND',
    name: 'North Dakota',
    slug: 'north-dakota',
    aliases: ['north dakota', 'nd'],
    nominatimQuery: 'North Dakota, USA',
    region: 'midwest',
    timeZoneGroup: 'MULTI',
    populationPriority: 47,
    boundingBox: { south: 45.9351, west: -104.0501, north: 49.0007, east: -96.5545 },
  },
  {
    code: 'OH',
    name: 'Ohio',
    slug: 'ohio',
    aliases: ['ohio', 'oh'],
    nominatimQuery: 'Ohio, USA',
    region: 'midwest',
    timeZoneGroup: 'ET',
    populationPriority: 7,
    boundingBox: { south: 38.4034, west: -84.8203, north: 41.9773, east: -80.5187 },
  },
  {
    code: 'OK',
    name: 'Oklahoma',
    slug: 'oklahoma',
    aliases: ['oklahoma', 'ok'],
    nominatimQuery: 'Oklahoma, USA',
    region: 'south',
    timeZoneGroup: 'CT',
    populationPriority: 28,
    boundingBox: { south: 33.6158, west: -103.0026, north: 37.0022, east: -94.4307 },
  },
  {
    code: 'OR',
    name: 'Oregon',
    slug: 'oregon',
    aliases: ['oregon', 'or'],
    nominatimQuery: 'Oregon, USA',
    region: 'pacific',
    timeZoneGroup: 'MULTI',
    populationPriority: 27,
    boundingBox: { south: 41.9918, west: -124.5662, north: 46.292, east: -116.4635 },
  },
  {
    code: 'PA',
    name: 'Pennsylvania',
    slug: 'pennsylvania',
    aliases: ['pennsylvania', 'pa'],
    nominatimQuery: 'Pennsylvania, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 5,
    boundingBox: { south: 39.7198, west: -80.5199, north: 42.2698, east: -74.6895 },
  },
  {
    code: 'RI',
    name: 'Rhode Island',
    slug: 'rhode-island',
    aliases: ['rhode island', 'ri'],
    nominatimQuery: 'Rhode Island, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 43,
    boundingBox: { south: 41.1464, west: -71.8628, north: 42.0188, east: -71.1206 },
  },
  {
    code: 'SC',
    name: 'South Carolina',
    slug: 'south-carolina',
    aliases: ['south carolina', 'sc'],
    nominatimQuery: 'South Carolina, USA',
    region: 'southeast',
    timeZoneGroup: 'ET',
    populationPriority: 23,
    boundingBox: { south: 32.0346, west: -83.3539, north: 35.2155, east: -78.542 },
  },
  {
    code: 'SD',
    name: 'South Dakota',
    slug: 'south-dakota',
    aliases: ['south dakota', 'sd'],
    nominatimQuery: 'South Dakota, USA',
    region: 'midwest',
    timeZoneGroup: 'MULTI',
    populationPriority: 46,
    boundingBox: { south: 42.4796, west: -104.0577, north: 45.9455, east: -96.4366 },
  },
  {
    code: 'TN',
    name: 'Tennessee',
    slug: 'tennessee',
    aliases: ['tennessee', 'tn'],
    nominatimQuery: 'Tennessee, USA',
    region: 'south',
    timeZoneGroup: 'MULTI',
    populationPriority: 16,
    boundingBox: { south: 34.9829, west: -90.3103, north: 36.6781, east: -81.6469 },
  },
  {
    code: 'TX',
    name: 'Texas',
    slug: 'texas',
    aliases: ['texas', 'tx'],
    nominatimQuery: 'Texas, USA',
    region: 'southwest',
    timeZoneGroup: 'MULTI',
    populationPriority: 2,
    boundingBox: { south: 25.8371, west: -106.6456, north: 36.5007, east: -93.5083 },
  },
  {
    code: 'UT',
    name: 'Utah',
    slug: 'utah',
    aliases: ['utah', 'ut'],
    nominatimQuery: 'Utah, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 31,
    boundingBox: { south: 36.9979, west: -114.0529, north: 42.0016, east: -109.0411 },
  },
  {
    code: 'VT',
    name: 'Vermont',
    slug: 'vermont',
    aliases: ['vermont', 'vt'],
    nominatimQuery: 'Vermont, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 49,
    boundingBox: { south: 42.7269, west: -73.4377, north: 45.0167, east: -71.465 },
  },
  {
    code: 'VA',
    name: 'Virginia',
    slug: 'virginia',
    aliases: ['virginia', 'va'],
    nominatimQuery: 'Virginia, USA',
    region: 'south',
    timeZoneGroup: 'ET',
    populationPriority: 12,
    boundingBox: { south: 36.5407, west: -83.6754, north: 39.466, east: -75.2423 },
  },
  {
    code: 'WA',
    name: 'Washington',
    slug: 'washington',
    aliases: ['washington', 'wa', 'washington state'],
    nominatimQuery: 'Washington State, USA',
    region: 'pacific',
    timeZoneGroup: 'PT',
    populationPriority: 13,
    boundingBox: { south: 45.5435, west: -124.8489, north: 49.0024, east: -116.9165 },
  },
  {
    code: 'WV',
    name: 'West Virginia',
    slug: 'west-virginia',
    aliases: ['west virginia', 'wv'],
    nominatimQuery: 'West Virginia, USA',
    region: 'south',
    timeZoneGroup: 'ET',
    populationPriority: 38,
    boundingBox: { south: 37.2015, west: -82.6447, north: 40.6388, east: -77.719 },
  },
  {
    code: 'WI',
    name: 'Wisconsin',
    slug: 'wisconsin',
    aliases: ['wisconsin', 'wi'],
    nominatimQuery: 'Wisconsin, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 20,
    boundingBox: { south: 42.4919, west: -92.8893, north: 47.0808, east: -86.2495 },
  },
  {
    code: 'WY',
    name: 'Wyoming',
    slug: 'wyoming',
    aliases: ['wyoming', 'wy'],
    nominatimQuery: 'Wyoming, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 50,
    boundingBox: { south: 40.9947, west: -111.0569, north: 45.0059, east: -104.0522 },
  },
] as const satisfies readonly UsStateProfile[];

const sortedUsStateProfiles: UsStateProfile[] = [...usStateProfiles].sort(
  (left, right) => left.populationPriority - right.populationPriority,
);

export const usStates = usStateProfiles.map((state) => ({
  code: state.code,
  name: state.name,
})) as ReadonlyArray<{
  code: UsStateCode;
  name: string;
}>;

export const usStateNames = Object.fromEntries(
  usStateProfiles.map((state) => [state.code, state.name] as const),
) as unknown as Record<UsStateCode, string>;

export const usStateCodeSet = new Set<UsStateCode>(usStateCodes);

export const usStateProfilesByCode = Object.fromEntries(
  usStateProfiles.map((state) => [state.code, state] as const),
) as unknown as Record<UsStateCode, UsStateProfile>;

export const usStateProfilesByName = Object.fromEntries(
  usStateProfiles.map((state) => [normalizeStateInput(state.name), state] as const),
) as Record<string, UsStateProfile>;

export const usStateProfilesByAlias = Object.fromEntries(
  usStateProfiles.flatMap((state) =>
    state.aliases.map((alias) => [normalizeStateInput(alias), state] as const),
  ),
) as Record<string, UsStateProfile>;

export const nationwideStateQueries = sortedUsStateProfiles.map(
  (state) => state.nominatimQuery,
);

export const nationwideStateNames = sortedUsStateProfiles.map(
  (state) => state.name,
);

export const nationwideStateCodes = sortedUsStateProfiles.map(
  (state) => state.code,
);

export const getUsStateProfile = (
  code: UsStateCode,
): UsStateProfile => usStateProfilesByCode[code];

export const isUsStateCode = (value: string): value is UsStateCode => {
  return usStateCodeSet.has(value.trim().toUpperCase() as UsStateCode);
};

export const resolveUsStateProfile = (
  input: string,
): UsStateProfile | undefined => {
  const normalized = normalizeStateInput(input);

  if (!normalized) {
    return undefined;
  }

  const upper = normalized.toUpperCase();

  if (isUsStateCode(upper)) {
    return usStateProfilesByCode[upper as UsStateCode];
  }

  return (
    usStateProfilesByAlias[normalized] ??
    usStateProfilesByName[normalized]
  );
};

export const getUsStateName = (
  code: UsStateCode,
): string => usStateProfilesByCode[code].name;

export const getUsStateCode = (
  input: string,
): UsStateCode | undefined => resolveUsStateProfile(input)?.code;

export const getUsStateBoundingBox = (
  input: string,
): UsBoundingBox | undefined => resolveUsStateProfile(input)?.boundingBox;

export const getUsStatesByRegion = (
  region: UsRegion,
): UsStateProfile[] => {
  return [...usStateProfiles]
    .filter((state) => state.region === region)
    .sort((left, right) => left.populationPriority - right.populationPriority);
};

export const getUsStatesByTimeZoneGroup = (
  timeZoneGroup: UsTimeZoneGroup,
): UsStateProfile[] => {
  return [...usStateProfiles]
    .filter((state) => state.timeZoneGroup === timeZoneGroup)
    .sort((left, right) => left.populationPriority - right.populationPriority);
};

export const getNationwideStateQueryBatches = (
  batchSize = 10,
): string[][] => {
  const safeBatchSize = Math.max(1, batchSize);
  const queries = [...nationwideStateQueries];

  const batches: string[][] = [];

  for (let index = 0; index < queries.length; index += safeBatchSize) {
    batches.push(queries.slice(index, index + safeBatchSize));
  }

  return batches;
};

export const isValidUsBoundingBox = (
  boundingBox: UsBoundingBox,
): boolean => {
  return (
    Number.isFinite(boundingBox.south) &&
    Number.isFinite(boundingBox.west) &&
    Number.isFinite(boundingBox.north) &&
    Number.isFinite(boundingBox.east) &&
    boundingBox.south < boundingBox.north &&
    boundingBox.west < boundingBox.east
  );
};

export const isPointInUsState = (
  input: string,
  point: {
    latitude: number;
    longitude: number;
  },
): boolean => {
  const boundingBox = getUsStateBoundingBox(input);

  if (!boundingBox || !isValidUsBoundingBox(boundingBox)) {
    return false;
  }

  return (
    point.latitude >= boundingBox.south &&
    point.latitude <= boundingBox.north &&
    point.longitude >= boundingBox.west &&
    point.longitude <= boundingBox.east
  );
};
