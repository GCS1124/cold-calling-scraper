export type UsTimeZoneCode = 'ET' | 'CT' | 'MT' | 'PT' | 'AKT' | 'HAT';

export type UsTimeZoneDefinition = {
  code: UsTimeZoneCode;
  label: string;
  standardLabel: string;
  daylightLabel?: string;
  utcStandardOffset: string;
  utcDaylightOffset?: string;
  aliases: string[];
  primaryStates: string[];
  partialStates: string[];
  queryStates: string[];
};

export type UsTimeZoneMatch = {
  code: UsTimeZoneCode;
  label: string;
  standardLabel: string;
  daylightLabel?: string;
  utcStandardOffset: string;
  utcDaylightOffset?: string;
  states: string[];
  primaryStates: string[];
  partialStates: string[];
  warnings: string[];
};

const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,]/g, ' ')
    .replace(/[\s._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const stateAliases: Record<string, string> = {
  al: 'Alabama',
  ak: 'Alaska',
  az: 'Arizona',
  ar: 'Arkansas',
  ca: 'California',
  co: 'Colorado',
  ct: 'Connecticut',
  de: 'Delaware',
  dc: 'District of Columbia',
  fl: 'Florida',
  ga: 'Georgia',
  hi: 'Hawaii',
  id: 'Idaho',
  il: 'Illinois',
  in: 'Indiana',
  ia: 'Iowa',
  ks: 'Kansas',
  ky: 'Kentucky',
  la: 'Louisiana',
  me: 'Maine',
  md: 'Maryland',
  ma: 'Massachusetts',
  mi: 'Michigan',
  mn: 'Minnesota',
  ms: 'Mississippi',
  mo: 'Missouri',
  mt: 'Montana',
  ne: 'Nebraska',
  nv: 'Nevada',
  nh: 'New Hampshire',
  nj: 'New Jersey',
  nm: 'New Mexico',
  ny: 'New York',
  nc: 'North Carolina',
  nd: 'North Dakota',
  oh: 'Ohio',
  ok: 'Oklahoma',
  or: 'Oregon',
  pa: 'Pennsylvania',
  ri: 'Rhode Island',
  sc: 'South Carolina',
  sd: 'South Dakota',
  tn: 'Tennessee',
  tx: 'Texas',
  ut: 'Utah',
  vt: 'Vermont',
  va: 'Virginia',
  wa: 'Washington',
  wv: 'West Virginia',
  wi: 'Wisconsin',
  wy: 'Wyoming',
};

const easternPrimaryStates = [
  'Connecticut',
  'Delaware',
  'District of Columbia',
  'Georgia',
  'Maine',
  'Maryland',
  'Massachusetts',
  'New Hampshire',
  'New Jersey',
  'New York',
  'North Carolina',
  'Ohio',
  'Pennsylvania',
  'Rhode Island',
  'South Carolina',
  'Vermont',
  'Virginia',
  'West Virginia',
];

const easternPartialStates = [
  'Florida',
  'Indiana',
  'Kentucky',
  'Michigan',
  'Tennessee',
];

const centralPrimaryStates = [
  'Alabama',
  'Arkansas',
  'Illinois',
  'Iowa',
  'Louisiana',
  'Minnesota',
  'Mississippi',
  'Missouri',
  'Oklahoma',
  'Wisconsin',
];

const centralPartialStates = [
  'Florida',
  'Indiana',
  'Kansas',
  'Kentucky',
  'Michigan',
  'Nebraska',
  'North Dakota',
  'South Dakota',
  'Tennessee',
  'Texas',
];

const mountainPrimaryStates = [
  'Arizona',
  'Colorado',
  'Montana',
  'New Mexico',
  'Utah',
  'Wyoming',
];

const mountainPartialStates = [
  'Idaho',
  'Kansas',
  'Nebraska',
  'Nevada',
  'North Dakota',
  'Oregon',
  'South Dakota',
  'Texas',
];

const pacificPrimaryStates = [
  'California',
  'Washington',
];

const pacificPartialStates = [
  'Idaho',
  'Nevada',
  'Oregon',
];

const alaskaPrimaryStates = ['Alaska'];
const hawaiiPrimaryStates = ['Hawaii'];

const unique = <T>(values: T[]) => [...new Set(values)];

const buildQueryStates = (primaryStates: string[], partialStates: string[]) =>
  unique([...primaryStates, ...partialStates]).sort((a, b) => a.localeCompare(b));

const timezoneDefinitions: readonly UsTimeZoneDefinition[] = [
  {
    code: 'ET',
    label: 'Eastern Time',
    standardLabel: 'Eastern Standard Time',
    daylightLabel: 'Eastern Daylight Time',
    utcStandardOffset: 'UTC-05:00',
    utcDaylightOffset: 'UTC-04:00',
    aliases: [
      'et',
      'est',
      'edt',
      'eastern',
      'eastern time',
      'eastern timezone',
      'eastern time zone',
      'eastern standard time',
      'eastern daylight time',
      'east coast time',
      'us eastern',
      'usa eastern',
    ],
    primaryStates: easternPrimaryStates,
    partialStates: easternPartialStates,
    queryStates: buildQueryStates(easternPrimaryStates, easternPartialStates),
  },
  {
    code: 'CT',
    label: 'Central Time',
    standardLabel: 'Central Standard Time',
    daylightLabel: 'Central Daylight Time',
    utcStandardOffset: 'UTC-06:00',
    utcDaylightOffset: 'UTC-05:00',
    aliases: [
      'ct',
      'cst',
      'cdt',
      'central',
      'central time',
      'central timezone',
      'central time zone',
      'central standard time',
      'central daylight time',
      'us central',
      'usa central',
    ],
    primaryStates: centralPrimaryStates,
    partialStates: centralPartialStates,
    queryStates: buildQueryStates(centralPrimaryStates, centralPartialStates),
  },
  {
    code: 'MT',
    label: 'Mountain Time',
    standardLabel: 'Mountain Standard Time',
    daylightLabel: 'Mountain Daylight Time',
    utcStandardOffset: 'UTC-07:00',
    utcDaylightOffset: 'UTC-06:00',
    aliases: [
      'mt',
      'mst',
      'mdt',
      'mountain',
      'mountain time',
      'mountain timezone',
      'mountain time zone',
      'mountain standard time',
      'mountain daylight time',
      'us mountain',
      'usa mountain',
    ],
    primaryStates: mountainPrimaryStates,
    partialStates: mountainPartialStates,
    queryStates: buildQueryStates(mountainPrimaryStates, mountainPartialStates),
  },
  {
    code: 'PT',
    label: 'Pacific Time',
    standardLabel: 'Pacific Standard Time',
    daylightLabel: 'Pacific Daylight Time',
    utcStandardOffset: 'UTC-08:00',
    utcDaylightOffset: 'UTC-07:00',
    aliases: [
      'pt',
      'pst',
      'pdt',
      'pacific',
      'pacific time',
      'pacific timezone',
      'pacific time zone',
      'pacific standard time',
      'pacific daylight time',
      'west coast time',
      'us pacific',
      'usa pacific',
    ],
    primaryStates: pacificPrimaryStates,
    partialStates: pacificPartialStates,
    queryStates: buildQueryStates(pacificPrimaryStates, pacificPartialStates),
  },
  {
    code: 'AKT',
    label: 'Alaska Time',
    standardLabel: 'Alaska Standard Time',
    daylightLabel: 'Alaska Daylight Time',
    utcStandardOffset: 'UTC-09:00',
    utcDaylightOffset: 'UTC-08:00',
    aliases: [
      'akt',
      'akst',
      'akdt',
      'alaska',
      'alaska time',
      'alaska timezone',
      'alaska time zone',
      'alaska standard time',
      'alaska daylight time',
    ],
    primaryStates: alaskaPrimaryStates,
    partialStates: [],
    queryStates: alaskaPrimaryStates,
  },
  {
    code: 'HAT',
    label: 'Hawaii Time',
    standardLabel: 'Hawaii-Aleutian Standard Time',
    utcStandardOffset: 'UTC-10:00',
    aliases: [
      'hat',
      'ht',
      'hst',
      'hawaii',
      'hawaiian',
      'hawaii time',
      'hawaii timezone',
      'hawaii time zone',
      'hawaiian standard time',
      'hawaii aleutian',
      'hawaii aleutian standard time',
    ],
    primaryStates: hawaiiPrimaryStates,
    partialStates: [],
    queryStates: hawaiiPrimaryStates,
  },
] as const;

export const usTimezoneDefinitions = timezoneDefinitions;

export const timezoneStateQueries = Object.fromEntries(
  timezoneDefinitions.map((definition) => [
    definition.code,
    definition.queryStates,
  ]),
) as Record<UsTimeZoneCode, string[]>;

export const timezonePrimaryStateQueries = Object.fromEntries(
  timezoneDefinitions.map((definition) => [
    definition.code,
    definition.primaryStates,
  ]),
) as Record<UsTimeZoneCode, string[]>;

export const timezonePartialStateQueries = Object.fromEntries(
  timezoneDefinitions.map((definition) => [
    definition.code,
    definition.partialStates,
  ]),
) as Record<UsTimeZoneCode, string[]>;

const timezoneAliasMap = new Map<string, UsTimeZoneDefinition>();

for (const definition of timezoneDefinitions) {
  timezoneAliasMap.set(normalize(definition.code), definition);
  timezoneAliasMap.set(normalize(definition.label), definition);
  timezoneAliasMap.set(normalize(definition.standardLabel), definition);

  if (definition.daylightLabel) {
    timezoneAliasMap.set(normalize(definition.daylightLabel), definition);
  }

  for (const alias of definition.aliases) {
    timezoneAliasMap.set(normalize(alias), definition);
  }
}

const stateToTimezoneDefinitions = new Map<string, UsTimeZoneDefinition[]>();

for (const definition of timezoneDefinitions) {
  for (const state of definition.queryStates) {
    const key = normalize(state);
    const existing = stateToTimezoneDefinitions.get(key) ?? [];
    stateToTimezoneDefinitions.set(key, [...existing, definition]);
  }
}

for (const [code, stateName] of Object.entries(stateAliases)) {
  const definitions = stateToTimezoneDefinitions.get(normalize(stateName));
  if (definitions?.length) {
    stateToTimezoneDefinitions.set(normalize(code), definitions);
  }
}

const toTimeZoneMatch = (
  definition: UsTimeZoneDefinition,
  warnings: string[] = [],
): UsTimeZoneMatch => ({
  code: definition.code,
  label: definition.label,
  standardLabel: definition.standardLabel,
  daylightLabel: definition.daylightLabel,
  utcStandardOffset: definition.utcStandardOffset,
  utcDaylightOffset: definition.utcDaylightOffset,
  states: definition.queryStates,
  primaryStates: definition.primaryStates,
  partialStates: definition.partialStates,
  warnings,
});

export const normalizeUsTimeZoneQuery = (
  rawValue: string,
): UsTimeZoneMatch | null => {
  const normalized = normalize(rawValue);

  if (!normalized) {
    return null;
  }

  const exactTimezone = timezoneAliasMap.get(normalized);

  if (exactTimezone) {
    return toTimeZoneMatch(exactTimezone);
  }

  const stateMatches = stateToTimezoneDefinitions.get(normalized);

  if (!stateMatches?.length) {
    return null;
  }

  if (stateMatches.length === 1) {
    return toTimeZoneMatch(stateMatches[0]);
  }

  return toTimeZoneMatch(stateMatches[0], [
    `"${rawValue.trim()}" spans multiple US time zones. Defaulted to ${stateMatches[0].label}. Use a city, ZIP, or explicit timezone for better precision.`,
  ]);
};

export const getUsTimeZoneDefinition = (
  code: UsTimeZoneCode,
): UsTimeZoneDefinition => {
  const definition = timezoneDefinitions.find((item) => item.code === code);

  if (!definition) {
    throw new Error(`Unknown US timezone code: ${code}`);
  }

  return definition;
};

export const getUsTimeZoneStates = (
  code: UsTimeZoneCode,
  options?: {
    includePartialStates?: boolean;
  },
): string[] => {
  const definition = getUsTimeZoneDefinition(code);

  if (options?.includePartialStates === false) {
    return definition.primaryStates;
  }

  return definition.queryStates;
};

export const getUsTimeZoneCodesForState = (
  stateOrCode: string,
): UsTimeZoneCode[] => {
  const normalized = normalize(stateOrCode);
  const matches = stateToTimezoneDefinitions.get(normalized) ?? [];

  return matches.map((definition) => definition.code);
};

export const isUsTimeZoneQuery = (rawValue: string): boolean => {
  return Boolean(timezoneAliasMap.get(normalize(rawValue)));
};