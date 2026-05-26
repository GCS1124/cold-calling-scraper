export type UsTimeZoneCode = 'ET' | 'CT' | 'MT' | 'PT' | 'AKT' | 'HAT';

type UsTimeZoneDefinition = {
  code: UsTimeZoneCode;
  label: string;
  aliases: string[];
  states: string[];
};

const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const timezoneDefinitions: UsTimeZoneDefinition[] = [
  {
    code: 'ET',
    label: 'Eastern Time',
    aliases: ['et', 'est', 'eastern', 'eastern time', 'eastern standard time'],
    states: [
      'Connecticut',
      'Delaware',
      'District of Columbia',
      'Florida',
      'Georgia',
      'Indiana',
      'Kentucky',
      'Maine',
      'Maryland',
      'Massachusetts',
      'Michigan',
      'New Hampshire',
      'New Jersey',
      'New York',
      'North Carolina',
      'Ohio',
      'Pennsylvania',
      'Rhode Island',
      'South Carolina',
      'Tennessee',
      'Vermont',
      'Virginia',
      'West Virginia',
    ],
  },
  {
    code: 'CT',
    label: 'Central Time',
    aliases: ['ct', 'cst', 'central', 'central time', 'central standard time'],
    states: [
      'Alabama',
      'Arkansas',
      'Illinois',
      'Iowa',
      'Kansas',
      'Louisiana',
      'Minnesota',
      'Mississippi',
      'Missouri',
      'Nebraska',
      'North Dakota',
      'Oklahoma',
      'South Dakota',
      'Tennessee',
      'Texas',
      'Wisconsin',
    ],
  },
  {
    code: 'MT',
    label: 'Mountain Time',
    aliases: ['mt', 'mst', 'mountain', 'mountain time', 'mountain standard time'],
    states: [
      'Arizona',
      'Colorado',
      'Idaho',
      'Montana',
      'New Mexico',
      'Utah',
      'Wyoming',
    ],
  },
  {
    code: 'PT',
    label: 'Pacific Time',
    aliases: ['pt', 'pst', 'pacific', 'pacific time', 'pacific standard time'],
    states: ['California', 'Nevada', 'Oregon', 'Washington'],
  },
  {
    code: 'AKT',
    label: 'Alaska Time',
    aliases: ['akt', 'akst', 'alaska', 'alaska time', 'alaska standard time'],
    states: ['Alaska'],
  },
  {
    code: 'HAT',
    label: 'Hawaii Time',
    aliases: ['ht', 'hst', 'hawaii', 'hawaii time', 'hawaiian standard time'],
    states: ['Hawaii'],
  },
];

export const timezoneStateQueries = Object.fromEntries(
  timezoneDefinitions.map((definition) => [definition.code, definition.states]),
) as Record<UsTimeZoneCode, string[]>;

const timezoneAliasMap = new Map<string, UsTimeZoneDefinition>();

for (const definition of timezoneDefinitions) {
  timezoneAliasMap.set(normalize(definition.code), definition);
  timezoneAliasMap.set(normalize(definition.label), definition);
  for (const alias of definition.aliases) {
    timezoneAliasMap.set(normalize(alias), definition);
  }
}

export const normalizeUsTimeZoneQuery = (rawValue: string) => {
  const normalized = normalize(rawValue);
  if (!normalized) {
    return null;
  }

  return timezoneAliasMap.get(normalized) ?? null;
};
