export type UsStateCode =
  | 'CA'
  | 'TX'
  | 'FL'
  | 'NY'
  | 'PA'
  | 'IL'
  | 'OH'
  | 'GA'
  | 'NC'
  | 'MI'
  | 'NJ'
  | 'VA'
  | 'WA'
  | 'AZ'
  | 'MA'
  | 'TN'
  | 'IN'
  | 'MO'
  | 'MD'
  | 'WI'
  | 'CO'
  | 'MN'
  | 'SC'
  | 'AL'
  | 'LA'
  | 'KY'
  | 'OR'
  | 'OK'
  | 'CT'
  | 'IA'
  | 'UT'
  | 'NV'
  | 'AR'
  | 'MS'
  | 'KS'
  | 'NM'
  | 'NE'
  | 'WV'
  | 'ID'
  | 'HI'
  | 'NH'
  | 'ME'
  | 'RI'
  | 'MT'
  | 'DE'
  | 'SD'
  | 'ND'
  | 'AK'
  | 'VT'
  | 'WY'
  | 'DC';

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

export type UsStateProfile = {
  code: UsStateCode;
  name: string;
  nominatimQuery: string;
  region: UsRegion;
  timeZoneGroup: UsTimeZoneGroup;
  populationPriority: number;
  aliases: string[];
  isDistrict?: boolean;
};

export const usStateProfiles: readonly UsStateProfile[] = [
  {
    code: 'CA',
    name: 'California',
    nominatimQuery: 'California, USA',
    region: 'west',
    timeZoneGroup: 'PT',
    populationPriority: 1,
    aliases: ['california', 'ca', 'cali'],
  },
  {
    code: 'TX',
    name: 'Texas',
    nominatimQuery: 'Texas, USA',
    region: 'southwest',
    timeZoneGroup: 'CT',
    populationPriority: 2,
    aliases: ['texas', 'tx'],
  },
  {
    code: 'FL',
    name: 'Florida',
    nominatimQuery: 'Florida, USA',
    region: 'southeast',
    timeZoneGroup: 'ET',
    populationPriority: 3,
    aliases: ['florida', 'fl'],
  },
  {
    code: 'NY',
    name: 'New York',
    nominatimQuery: 'New York State, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 4,
    aliases: ['new york', 'ny', 'new york state', 'nys'],
  },
  {
    code: 'PA',
    name: 'Pennsylvania',
    nominatimQuery: 'Pennsylvania, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 5,
    aliases: ['pennsylvania', 'pa'],
  },
  {
    code: 'IL',
    name: 'Illinois',
    nominatimQuery: 'Illinois, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 6,
    aliases: ['illinois', 'il'],
  },
  {
    code: 'OH',
    name: 'Ohio',
    nominatimQuery: 'Ohio, USA',
    region: 'midwest',
    timeZoneGroup: 'ET',
    populationPriority: 7,
    aliases: ['ohio', 'oh'],
  },
  {
    code: 'GA',
    name: 'Georgia',
    nominatimQuery: 'Georgia, USA',
    region: 'southeast',
    timeZoneGroup: 'ET',
    populationPriority: 8,
    aliases: ['georgia', 'ga'],
  },
  {
    code: 'NC',
    name: 'North Carolina',
    nominatimQuery: 'North Carolina, USA',
    region: 'southeast',
    timeZoneGroup: 'ET',
    populationPriority: 9,
    aliases: ['north carolina', 'nc'],
  },
  {
    code: 'MI',
    name: 'Michigan',
    nominatimQuery: 'Michigan, USA',
    region: 'midwest',
    timeZoneGroup: 'ET',
    populationPriority: 10,
    aliases: ['michigan', 'mi'],
  },
  {
    code: 'NJ',
    name: 'New Jersey',
    nominatimQuery: 'New Jersey, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 11,
    aliases: ['new jersey', 'nj'],
  },
  {
    code: 'VA',
    name: 'Virginia',
    nominatimQuery: 'Virginia, USA',
    region: 'south',
    timeZoneGroup: 'ET',
    populationPriority: 12,
    aliases: ['virginia', 'va'],
  },
  {
    code: 'WA',
    name: 'Washington',
    nominatimQuery: 'Washington State, USA',
    region: 'pacific',
    timeZoneGroup: 'PT',
    populationPriority: 13,
    aliases: ['washington', 'wa', 'washington state'],
  },
  {
    code: 'AZ',
    name: 'Arizona',
    nominatimQuery: 'Arizona, USA',
    region: 'southwest',
    timeZoneGroup: 'MT',
    populationPriority: 14,
    aliases: ['arizona', 'az'],
  },
  {
    code: 'MA',
    name: 'Massachusetts',
    nominatimQuery: 'Massachusetts, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 15,
    aliases: ['massachusetts', 'ma'],
  },
  {
    code: 'TN',
    name: 'Tennessee',
    nominatimQuery: 'Tennessee, USA',
    region: 'south',
    timeZoneGroup: 'CT',
    populationPriority: 16,
    aliases: ['tennessee', 'tn'],
  },
  {
    code: 'IN',
    name: 'Indiana',
    nominatimQuery: 'Indiana, USA',
    region: 'midwest',
    timeZoneGroup: 'ET',
    populationPriority: 17,
    aliases: ['indiana', 'in'],
  },
  {
    code: 'MO',
    name: 'Missouri',
    nominatimQuery: 'Missouri, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 18,
    aliases: ['missouri', 'mo'],
  },
  {
    code: 'MD',
    name: 'Maryland',
    nominatimQuery: 'Maryland, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 19,
    aliases: ['maryland', 'md'],
  },
  {
    code: 'WI',
    name: 'Wisconsin',
    nominatimQuery: 'Wisconsin, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 20,
    aliases: ['wisconsin', 'wi'],
  },
  {
    code: 'CO',
    name: 'Colorado',
    nominatimQuery: 'Colorado, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 21,
    aliases: ['colorado', 'co'],
  },
  {
    code: 'MN',
    name: 'Minnesota',
    nominatimQuery: 'Minnesota, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 22,
    aliases: ['minnesota', 'mn'],
  },
  {
    code: 'SC',
    name: 'South Carolina',
    nominatimQuery: 'South Carolina, USA',
    region: 'southeast',
    timeZoneGroup: 'ET',
    populationPriority: 23,
    aliases: ['south carolina', 'sc'],
  },
  {
    code: 'AL',
    name: 'Alabama',
    nominatimQuery: 'Alabama, USA',
    region: 'southeast',
    timeZoneGroup: 'CT',
    populationPriority: 24,
    aliases: ['alabama', 'al'],
  },
  {
    code: 'LA',
    name: 'Louisiana',
    nominatimQuery: 'Louisiana, USA',
    region: 'south',
    timeZoneGroup: 'CT',
    populationPriority: 25,
    aliases: ['louisiana', 'la'],
  },
  {
    code: 'KY',
    name: 'Kentucky',
    nominatimQuery: 'Kentucky, USA',
    region: 'south',
    timeZoneGroup: 'ET',
    populationPriority: 26,
    aliases: ['kentucky', 'ky'],
  },
  {
    code: 'OR',
    name: 'Oregon',
    nominatimQuery: 'Oregon, USA',
    region: 'pacific',
    timeZoneGroup: 'PT',
    populationPriority: 27,
    aliases: ['oregon', 'or'],
  },
  {
    code: 'OK',
    name: 'Oklahoma',
    nominatimQuery: 'Oklahoma, USA',
    region: 'south',
    timeZoneGroup: 'CT',
    populationPriority: 28,
    aliases: ['oklahoma', 'ok'],
  },
  {
    code: 'CT',
    name: 'Connecticut',
    nominatimQuery: 'Connecticut, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 29,
    aliases: ['connecticut', 'ct'],
  },
  {
    code: 'IA',
    name: 'Iowa',
    nominatimQuery: 'Iowa, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 30,
    aliases: ['iowa', 'ia'],
  },
  {
    code: 'UT',
    name: 'Utah',
    nominatimQuery: 'Utah, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 31,
    aliases: ['utah', 'ut'],
  },
  {
    code: 'NV',
    name: 'Nevada',
    nominatimQuery: 'Nevada, USA',
    region: 'west',
    timeZoneGroup: 'PT',
    populationPriority: 32,
    aliases: ['nevada', 'nv'],
  },
  {
    code: 'AR',
    name: 'Arkansas',
    nominatimQuery: 'Arkansas, USA',
    region: 'south',
    timeZoneGroup: 'CT',
    populationPriority: 33,
    aliases: ['arkansas', 'ar'],
  },
  {
    code: 'MS',
    name: 'Mississippi',
    nominatimQuery: 'Mississippi, USA',
    region: 'southeast',
    timeZoneGroup: 'CT',
    populationPriority: 34,
    aliases: ['mississippi', 'ms'],
  },
  {
    code: 'KS',
    name: 'Kansas',
    nominatimQuery: 'Kansas, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 35,
    aliases: ['kansas', 'ks'],
  },
  {
    code: 'NM',
    name: 'New Mexico',
    nominatimQuery: 'New Mexico, USA',
    region: 'southwest',
    timeZoneGroup: 'MT',
    populationPriority: 36,
    aliases: ['new mexico', 'nm'],
  },
  {
    code: 'NE',
    name: 'Nebraska',
    nominatimQuery: 'Nebraska, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 37,
    aliases: ['nebraska', 'ne'],
  },
  {
    code: 'WV',
    name: 'West Virginia',
    nominatimQuery: 'West Virginia, USA',
    region: 'south',
    timeZoneGroup: 'ET',
    populationPriority: 38,
    aliases: ['west virginia', 'wv'],
  },
  {
    code: 'ID',
    name: 'Idaho',
    nominatimQuery: 'Idaho, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 39,
    aliases: ['idaho', 'id'],
  },
  {
    code: 'HI',
    name: 'Hawaii',
    nominatimQuery: 'Hawaii, USA',
    region: 'nonContiguous',
    timeZoneGroup: 'HAT',
    populationPriority: 40,
    aliases: ['hawaii', 'hi'],
  },
  {
    code: 'NH',
    name: 'New Hampshire',
    nominatimQuery: 'New Hampshire, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 41,
    aliases: ['new hampshire', 'nh'],
  },
  {
    code: 'ME',
    name: 'Maine',
    nominatimQuery: 'Maine, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 42,
    aliases: ['maine', 'me'],
  },
  {
    code: 'RI',
    name: 'Rhode Island',
    nominatimQuery: 'Rhode Island, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 43,
    aliases: ['rhode island', 'ri'],
  },
  {
    code: 'MT',
    name: 'Montana',
    nominatimQuery: 'Montana, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 44,
    aliases: ['montana', 'mt'],
  },
  {
    code: 'DE',
    name: 'Delaware',
    nominatimQuery: 'Delaware, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 45,
    aliases: ['delaware', 'de'],
  },
  {
    code: 'SD',
    name: 'South Dakota',
    nominatimQuery: 'South Dakota, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 46,
    aliases: ['south dakota', 'sd'],
  },
  {
    code: 'ND',
    name: 'North Dakota',
    nominatimQuery: 'North Dakota, USA',
    region: 'midwest',
    timeZoneGroup: 'CT',
    populationPriority: 47,
    aliases: ['north dakota', 'nd'],
  },
  {
    code: 'AK',
    name: 'Alaska',
    nominatimQuery: 'Alaska, USA',
    region: 'nonContiguous',
    timeZoneGroup: 'AKT',
    populationPriority: 48,
    aliases: ['alaska', 'ak'],
  },
  {
    code: 'VT',
    name: 'Vermont',
    nominatimQuery: 'Vermont, USA',
    region: 'northeast',
    timeZoneGroup: 'ET',
    populationPriority: 49,
    aliases: ['vermont', 'vt'],
  },
  {
    code: 'WY',
    name: 'Wyoming',
    nominatimQuery: 'Wyoming, USA',
    region: 'west',
    timeZoneGroup: 'MT',
    populationPriority: 50,
    aliases: ['wyoming', 'wy'],
  },
  {
    code: 'DC',
    name: 'District of Columbia',
    nominatimQuery: 'District of Columbia, USA',
    region: 'midAtlantic',
    timeZoneGroup: 'ET',
    populationPriority: 51,
    aliases: ['district of columbia', 'dc', 'washington dc', 'washington, dc'],
    isDistrict: true,
  },
] as const;

export const nationwideStateQueries = usStateProfiles.map(
  (state) => state.nominatimQuery,
);

export const nationwideStateNames = usStateProfiles.map(
  (state) => state.name,
);

export const nationwideStateCodes = usStateProfiles.map(
  (state) => state.code,
);

export const usStateProfilesByCode = Object.fromEntries(
  usStateProfiles.map((state) => [state.code, state]),
) as Record<UsStateCode, UsStateProfile>;

export const usStateProfilesByName = Object.fromEntries(
  usStateProfiles.map((state) => [state.name.toLowerCase(), state]),
) as Record<string, UsStateProfile>;

export const usStateProfilesByAlias = Object.fromEntries(
  usStateProfiles.flatMap((state) =>
    state.aliases.map((alias) => [alias.toLowerCase(), state]),
  ),
) as Record<string, UsStateProfile>;

export const resolveUsStateProfile = (
  input: string,
): UsStateProfile | undefined => {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');

  return (
    usStateProfilesByAlias[normalized] ??
    usStateProfilesByName[normalized] ??
    usStateProfilesByCode[normalized.toUpperCase() as UsStateCode]
  );
};

export const getNationwideStateQueriesByRegion = (
  region: UsRegion,
): string[] => {
  return usStateProfiles
    .filter((state) => state.region === region)
    .sort((a, b) => a.populationPriority - b.populationPriority)
    .map((state) => state.nominatimQuery);
};

export const getNationwideStateQueriesByTimeZone = (
  timeZoneGroup: UsTimeZoneGroup,
): string[] => {
  return usStateProfiles
    .filter((state) => state.timeZoneGroup === timeZoneGroup)
    .sort((a, b) => a.populationPriority - b.populationPriority)
    .map((state) => state.nominatimQuery);
};

export const getNationwideStateQueryBatches = (
  batchSize = 10,
): string[][] => {
  const sortedQueries = [...usStateProfiles]
    .sort((a, b) => a.populationPriority - b.populationPriority)
    .map((state) => state.nominatimQuery);

  const batches: string[][] = [];

  for (let index = 0; index < sortedQueries.length; index += batchSize) {
    batches.push(sortedQueries.slice(index, index + batchSize));
  }

  return batches;
};