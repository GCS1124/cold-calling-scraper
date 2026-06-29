import type { ProviderWarning } from '../types/search';

export type CategoryProfile = {
  key: string;
  label: string;
  tagClauses: string[];
  searchTerms: string[];
  warnings: ProviderWarning[];
};

type CategoryProfileBase = Omit<CategoryProfile, 'warnings'> & {
  aliases?: string[];
};

const normalizeText = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[-_/]/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const singularize = (value: string): string => {
  return value
    .replace(/\bcompanies\b/g, 'company')
    .replace(/\bagencies\b/g, 'agency')
    .replace(/\bservices\b/g, 'service')
    .replace(/\bclinics\b/g, 'clinic')
    .replace(/\bfirms\b/g, 'firm')
    .replace(/\bcontractors\b/g, 'contractor')
    .replace(/\bshops\b/g, 'shop')
    .replace(/\bstores\b/g, 'store')
    .replace(/\brestaurants\b/g, 'restaurant')
    .replace(/\bgyms\b/g, 'gym')
    .replace(/\bsalons\b/g, 'salon')
    .replace(/\bdealers\b/g, 'dealer')
    .replace(/\bcenters\b/g, 'center')
    .replace(/\bcentres\b/g, 'center')
    .replace(/\bschools\b/g, 'school')
    .replace(/\bs\b/g, '');
};

const escapeRegexValue = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"');
};

const makeNameRegexClause = (terms: string[]): string => {
  const safeTerms = terms
    .map((term) => normalizeText(term))
    .filter(Boolean)
    .map(escapeRegexValue);

  const regex = safeTerms.join('|');

  return `["name"~"${regex}",i]`;
};

const categoryProfiles: Record<string, CategoryProfileBase> = {
  // Healthcare
  'dental clinics': {
    key: 'dental-clinics',
    label: 'Dental Clinics',
    tagClauses: [
      '["amenity"="dentist"]',
      '["healthcare"="dentist"]',
      '["healthcare:speciality"~"orthodontics|periodontics|oral_surgery|cosmetic_dentistry",i]',
    ],
    searchTerms: [
      'dentist',
      'dental clinic',
      'dental office',
      'orthodontist',
      'periodontist',
      'oral surgeon',
      'cosmetic dentist',
      'family dentist',
      'pediatric dentist',
      'emergency dentist',
    ],
    aliases: [
      'dentist',
      'dentists',
      'dental',
      'dental clinic',
      'dental clinics',
      'dental office',
      'dental offices',
      'orthodontist',
      'orthodontists',
      'periodontist',
      'periodontists',
      'oral surgeon',
      'oral surgeons',
      'cosmetic dentist',
      'pediatric dentist',
    ],
  },

  'medical clinics': {
    key: 'medical-clinics',
    label: 'Medical Clinics',
    tagClauses: [
      '["amenity"="clinic"]',
      '["healthcare"="clinic"]',
      '["healthcare"="doctor"]',
      '["amenity"="doctors"]',
    ],
    searchTerms: [
      'medical clinic',
      'health clinic',
      'urgent care',
      'doctor office',
      'family medicine',
      'primary care',
      'walk in clinic',
      'general physician',
      'healthcare clinic',
    ],
    aliases: [
      'medical clinic',
      'medical clinics',
      'clinic',
      'clinics',
      'health clinic',
      'urgent care',
      'doctor',
      'doctors',
      'doctor office',
      'physician',
      'general physician',
      'primary care',
      'family medicine',
    ],
  },

  hospitals: {
    key: 'hospitals',
    label: 'Hospitals',
    tagClauses: ['["amenity"="hospital"]', '["healthcare"="hospital"]'],
    searchTerms: ['hospital', 'medical center', 'emergency room', 'emergency hospital'],
    aliases: ['hospital', 'hospitals', 'medical center', 'medical centre', 'emergency room', 'er'],
  },

  pharmacies: {
    key: 'pharmacies',
    label: 'Pharmacies',
    tagClauses: ['["amenity"="pharmacy"]', '["healthcare"="pharmacy"]', '["shop"="chemist"]'],
    searchTerms: ['pharmacy', 'drugstore', 'chemist', 'medical store'],
    aliases: ['pharmacy', 'pharmacies', 'drugstore', 'drug store', 'chemist', 'medical store'],
  },

  veterinarians: {
    key: 'veterinarians',
    label: 'Veterinarians',
    tagClauses: ['["amenity"="veterinary"]', '["healthcare"="veterinary"]'],
    searchTerms: ['veterinarian', 'vet clinic', 'animal hospital', 'pet clinic'],
    aliases: ['vet', 'vets', 'veterinarian', 'veterinarians', 'veterinary clinic', 'animal hospital', 'pet clinic'],
  },

  // Home services
  plumbers: {
    key: 'plumbers',
    label: 'Plumbers',
    tagClauses: ['["craft"="plumber"]', makeNameRegexClause(['plumber', 'plumbing'])],
    searchTerms: [
      'plumber',
      'plumbing company',
      'plumbing service',
      'emergency plumber',
      'drain cleaning',
      'water heater repair',
      'pipe repair',
      'leak repair',
    ],
    aliases: [
      'plumber',
      'plumbers',
      'plumbing',
      'plumbing company',
      'plumbing service',
      'emergency plumber',
      'drain cleaning',
      'water heater repair',
    ],
  },

  electricians: {
    key: 'electricians',
    label: 'Electricians',
    tagClauses: ['["craft"="electrician"]', makeNameRegexClause(['electrician', 'electrical'])],
    searchTerms: [
      'electrician',
      'electrical contractor',
      'electrical service',
      'emergency electrician',
      'electrical repair',
      'wiring repair',
    ],
    aliases: [
      'electrician',
      'electricians',
      'electrical contractor',
      'electrical service',
      'electrical repair',
      'wiring repair',
    ],
  },

  'roofing contractors': {
    key: 'roofing-contractors',
    label: 'Roofing Contractors',
    tagClauses: ['["craft"="roofer"]', makeNameRegexClause(['roofer', 'roofing', 'roof repair'])],
    searchTerms: ['roofer', 'roofing company', 'roof repair', 'roof replacement', 'roof inspection'],
    aliases: [
      'roofer',
      'roofers',
      'roofing',
      'roofing company',
      'roofing contractor',
      'roofing contractors',
      'roof repair',
      'roof replacement',
    ],
  },

  'hvac contractors': {
    key: 'hvac-contractors',
    label: 'HVAC Contractors',
    tagClauses: [
      '["craft"="hvac"]',
      '["craft"="heating_engineer"]',
      makeNameRegexClause(['hvac', 'air conditioning', 'heating', 'cooling', 'furnace']),
    ],
    searchTerms: [
      'hvac',
      'hvac contractor',
      'air conditioning',
      'air conditioning repair',
      'ac repair',
      'heating contractor',
      'furnace repair',
      'heating and cooling',
    ],
    aliases: [
      'hvac',
      'hvac contractor',
      'hvac contractors',
      'air conditioning',
      'air conditioning repair',
      'ac repair',
      'heating repair',
      'heating contractor',
      'furnace repair',
      'heating and cooling',
    ],
  },

  'cleaning services': {
    key: 'cleaning-services',
    label: 'Cleaning Services',
    tagClauses: [
      '["office"="cleaning_company"]',
      makeNameRegexClause(['cleaning', 'janitorial', 'maid', 'house cleaning', 'commercial cleaning']),
    ],
    searchTerms: [
      'cleaning service',
      'cleaning company',
      'janitorial services',
      'maid service',
      'house cleaning',
      'commercial cleaning',
      'commercial cleaner',
      'office cleaning',
    ],
    aliases: [
      'cleaning',
      'cleaner',
      'cleaners',
      'cleaning service',
      'cleaning services',
      'cleaning company',
      'janitorial service',
      'janitorial services',
      'house cleaning',
      'maid service',
      'commercial cleaning',
      'office cleaning',
    ],
  },

  landscapers: {
    key: 'landscapers',
    label: 'Landscapers',
    tagClauses: [
      '["craft"="gardener"]',
      '["office"="landscape_architect"]',
      makeNameRegexClause(['landscaping', 'lawn care', 'gardening', 'tree service']),
    ],
    searchTerms: ['landscaping', 'landscaper', 'lawn care', 'gardener', 'tree service', 'garden maintenance'],
    aliases: ['landscaper', 'landscapers', 'landscaping', 'lawn care', 'gardener', 'gardening', 'tree service'],
  },

  'pest control': {
    key: 'pest-control',
    label: 'Pest Control',
    tagClauses: [makeNameRegexClause(['pest control', 'exterminator', 'termite control'])],
    searchTerms: ['pest control', 'exterminator', 'termite control', 'rodent control', 'bug removal'],
    aliases: ['pest control', 'exterminator', 'exterminators', 'termite control', 'rodent control'],
  },

  movers: {
    key: 'movers',
    label: 'Moving Companies',
    tagClauses: [makeNameRegexClause(['moving company', 'movers', 'relocation', 'removals'])],
    searchTerms: ['moving company', 'movers', 'relocation service', 'packing and moving', 'removals'],
    aliases: ['mover', 'movers', 'moving company', 'moving service', 'relocation service', 'packers and movers'],
  },

  // Legal / finance / real estate
  'law firms': {
    key: 'law-firms',
    label: 'Law Firms',
    tagClauses: ['["office"="lawyer"]', makeNameRegexClause(['lawyer', 'attorney', 'law firm', 'legal'])],
    searchTerms: [
      'lawyer',
      'attorney',
      'law office',
      'law firm',
      'legal services',
      'personal injury lawyer',
      'family law attorney',
      'criminal defense attorney',
    ],
    aliases: [
      'lawyer',
      'lawyers',
      'attorney',
      'attorneys',
      'law firm',
      'law firms',
      'law office',
      'legal services',
      'personal injury lawyer',
      'family law attorney',
      'criminal defense attorney',
    ],
  },

  'real estate agencies': {
    key: 'real-estate-agencies',
    label: 'Real Estate Agencies',
    tagClauses: ['["office"="estate_agent"]', makeNameRegexClause(['real estate', 'realtor', 'property management'])],
    searchTerms: [
      'real estate agency',
      'real estate agent',
      'realtor',
      'broker',
      'property management',
      'estate agent',
    ],
    aliases: [
      'real estate',
      'real estate agency',
      'real estate agencies',
      'real estate agent',
      'realtor',
      'broker',
      'estate agent',
      'property management',
    ],
  },

  accountants: {
    key: 'accountants',
    label: 'Accountants',
    tagClauses: ['["office"="accountant"]', makeNameRegexClause(['accountant', 'cpa', 'tax preparation', 'bookkeeping'])],
    searchTerms: ['accountant', 'cpa', 'tax preparation', 'bookkeeper', 'bookkeeping', 'tax consultant'],
    aliases: ['accountant', 'accountants', 'cpa', 'tax preparation', 'bookkeeper', 'bookkeeping', 'tax consultant'],
  },

  'insurance agencies': {
    key: 'insurance-agencies',
    label: 'Insurance Agencies',
    tagClauses: ['["office"="insurance"]', makeNameRegexClause(['insurance agency', 'insurance agent'])],
    searchTerms: ['insurance agency', 'insurance agent', 'auto insurance', 'home insurance', 'life insurance'],
    aliases: ['insurance', 'insurance agency', 'insurance agencies', 'insurance agent', 'insurance broker'],
  },

  // Automotive
  'auto repair': {
    key: 'auto-repair',
    label: 'Auto Repair',
    tagClauses: [
      '["shop"="car_repair"]',
      '["craft"="car_repair"]',
      makeNameRegexClause(['auto repair', 'car repair', 'mechanic', 'auto service']),
    ],
    searchTerms: ['auto repair shop', 'car repair', 'mechanic', 'auto service', 'brake shop', 'tire shop'],
    aliases: [
      'auto repair',
      'auto repair shop',
      'car repair',
      'car repair shop',
      'mechanic',
      'mechanics',
      'auto service',
      'brake shop',
      'tire shop',
    ],
  },

  'car dealerships': {
    key: 'car-dealerships',
    label: 'Car Dealerships',
    tagClauses: ['["shop"="car"]', makeNameRegexClause(['car dealer', 'auto dealer', 'dealership'])],
    searchTerms: ['car dealer', 'car dealership', 'auto dealer', 'used car dealer'],
    aliases: ['car dealer', 'car dealers', 'car dealership', 'car dealerships', 'auto dealer', 'used car dealer'],
  },

  'car wash': {
    key: 'car-wash',
    label: 'Car Wash',
    tagClauses: ['["amenity"="car_wash"]', makeNameRegexClause(['car wash', 'auto detailing'])],
    searchTerms: ['car wash', 'auto detailing', 'vehicle wash', 'car detailing'],
    aliases: ['car wash', 'carwash', 'auto detailing', 'car detailing'],
  },

  // Food and hospitality
  restaurants: {
    key: 'restaurants',
    label: 'Restaurants',
    tagClauses: ['["amenity"="restaurant"]', '["amenity"="fast_food"]', '["amenity"="food_court"]'],
    searchTerms: ['restaurant', 'food restaurant', 'dining', 'fast food', 'takeout'],
    aliases: ['restaurant', 'restaurants', 'food', 'dining', 'fast food', 'takeout', 'eatery'],
  },

  cafes: {
    key: 'cafes',
    label: 'Cafes',
    tagClauses: ['["amenity"="cafe"]', makeNameRegexClause(['cafe', 'coffee shop'])],
    searchTerms: ['cafe', 'coffee shop', 'coffee house', 'espresso bar'],
    aliases: ['cafe', 'cafes', 'coffee shop', 'coffee shops', 'coffee house'],
  },

  bakeries: {
    key: 'bakeries',
    label: 'Bakeries',
    tagClauses: ['["shop"="bakery"]', makeNameRegexClause(['bakery', 'bakeshop', 'cake shop'])],
    searchTerms: ['bakery', 'cake shop', 'pastry shop', 'bread shop'],
    aliases: ['bakery', 'bakeries', 'cake shop', 'pastry shop', 'bread shop'],
  },

  bars: {
    key: 'bars',
    label: 'Bars',
    tagClauses: ['["amenity"="bar"]', '["amenity"="pub"]', '["amenity"="biergarten"]'],
    searchTerms: ['bar', 'pub', 'cocktail bar', 'sports bar'],
    aliases: ['bar', 'bars', 'pub', 'pubs', 'cocktail bar', 'sports bar'],
  },

  hotels: {
    key: 'hotels',
    label: 'Hotels',
    tagClauses: ['["tourism"="hotel"]', '["tourism"="motel"]', '["tourism"="guest_house"]'],
    searchTerms: ['hotel', 'motel', 'guest house', 'inn', 'lodging'],
    aliases: ['hotel', 'hotels', 'motel', 'motels', 'guest house', 'inn', 'lodging'],
  },

  // Beauty and wellness
  'hair salons': {
    key: 'hair-salons',
    label: 'Hair Salons',
    tagClauses: ['["shop"="hairdresser"]', makeNameRegexClause(['hair salon', 'hairdresser', 'barber'])],
    searchTerms: ['hair salon', 'hairdresser', 'barber shop', 'hair stylist'],
    aliases: ['hair salon', 'hair salons', 'salon', 'salons', 'hairdresser', 'barber', 'barber shop', 'hair stylist'],
  },

  'beauty salons': {
    key: 'beauty-salons',
    label: 'Beauty Salons',
    tagClauses: ['["shop"="beauty"]', makeNameRegexClause(['beauty salon', 'spa', 'nail salon', 'esthetician'])],
    searchTerms: ['beauty salon', 'nail salon', 'spa', 'esthetician', 'facial spa', 'skin care clinic'],
    aliases: [
      'beauty salon',
      'beauty salons',
      'nail salon',
      'nail salons',
      'spa',
      'spas',
      'esthetician',
      'facial spa',
      'skin care',
    ],
  },

  gyms: {
    key: 'gyms',
    label: 'Gyms',
    tagClauses: ['["leisure"="fitness_centre"]', '["leisure"="sports_centre"]', makeNameRegexClause(['gym', 'fitness'])],
    searchTerms: ['gym', 'fitness center', 'fitness club', 'personal trainer', 'health club'],
    aliases: ['gym', 'gyms', 'fitness center', 'fitness centre', 'fitness club', 'health club', 'personal trainer'],
  },

  // Education
  schools: {
    key: 'schools',
    label: 'Schools',
    tagClauses: ['["amenity"="school"]', '["amenity"="kindergarten"]'],
    searchTerms: ['school', 'private school', 'elementary school', 'high school', 'kindergarten'],
    aliases: ['school', 'schools', 'private school', 'elementary school', 'high school', 'kindergarten'],
  },

  colleges: {
    key: 'colleges',
    label: 'Colleges and Universities',
    tagClauses: ['["amenity"="college"]', '["amenity"="university"]'],
    searchTerms: ['college', 'university', 'higher education', 'training institute'],
    aliases: ['college', 'colleges', 'university', 'universities', 'training institute', 'institute'],
  },

  'day care': {
    key: 'day-care',
    label: 'Day Care',
    tagClauses: ['["amenity"="childcare"]', '["amenity"="kindergarten"]', makeNameRegexClause(['daycare', 'day care', 'child care'])],
    searchTerms: ['daycare', 'day care', 'child care', 'preschool', 'nursery school'],
    aliases: ['daycare', 'day care', 'child care', 'childcare', 'preschool', 'nursery school'],
  },

  // Retail
  grocery: {
    key: 'grocery',
    label: 'Grocery Stores',
    tagClauses: ['["shop"="supermarket"]', '["shop"="convenience"]', '["shop"="greengrocer"]'],
    searchTerms: ['grocery store', 'supermarket', 'convenience store', 'food market'],
    aliases: ['grocery', 'grocery store', 'grocery stores', 'supermarket', 'convenience store', 'food market'],
  },

  'clothing stores': {
    key: 'clothing-stores',
    label: 'Clothing Stores',
    tagClauses: ['["shop"="clothes"]', '["shop"="fashion"]', makeNameRegexClause(['clothing', 'fashion', 'apparel'])],
    searchTerms: ['clothing store', 'fashion store', 'apparel store', 'boutique'],
    aliases: ['clothing', 'clothing store', 'clothing stores', 'fashion store', 'apparel', 'boutique'],
  },

  'electronics stores': {
    key: 'electronics-stores',
    label: 'Electronics Stores',
    tagClauses: ['["shop"="electronics"]', '["shop"="computer"]', '["shop"="mobile_phone"]'],
    searchTerms: ['electronics store', 'computer store', 'mobile phone store', 'phone repair'],
    aliases: ['electronics', 'electronics store', 'computer store', 'mobile store', 'phone store', 'mobile phone store'],
  },

  'furniture stores': {
    key: 'furniture-stores',
    label: 'Furniture Stores',
    tagClauses: ['["shop"="furniture"]', makeNameRegexClause(['furniture', 'mattress'])],
    searchTerms: ['furniture store', 'mattress store', 'home furniture', 'office furniture'],
    aliases: ['furniture', 'furniture store', 'furniture stores', 'mattress store', 'home furniture'],
  },

  // Agencies and B2B
  'marketing agencies': {
    key: 'marketing-agencies',
    label: 'Marketing Agencies',
    tagClauses: [
      '["office"="advertising_agency"]',
      makeNameRegexClause(['marketing agency', 'digital marketing', 'advertising agency', 'seo agency']),
    ],
    searchTerms: [
      'marketing agency',
      'digital marketing',
      'advertising agency',
      'seo agency',
      'social media marketing',
      'lead generation agency',
      'performance marketing',
      'branding agency',
    ],
    aliases: [
      'marketing',
      'marketing agency',
      'marketing agencies',
      'digital marketing',
      'advertising agency',
      'seo agency',
      'social media marketing',
      'lead generation agency',
      'branding agency',
      'performance marketing',
    ],
  },

  'software companies': {
    key: 'software-companies',
    label: 'Software Companies',
    tagClauses: [
      '["office"="it"]',
      '["office"="company"]',
      makeNameRegexClause(['software', 'saas', 'tech', 'it services', 'web development', 'app development']),
    ],
    searchTerms: [
      'software company',
      'tech company',
      'it services',
      'software development',
      'web development',
      'app development',
      'saas company',
      'technology company',
    ],
    aliases: [
      'saas',
      'saas agency',
      'saas agencies',
      'software agency',
      'software agencies',
      'software company',
      'software companies',
      'tech company',
      'technology company',
      'it services',
      'software development',
      'web development',
      'app development',
    ],
  },

  consultants: {
    key: 'consultants',
    label: 'Consultants',
    tagClauses: ['["office"="consulting"]', makeNameRegexClause(['consultant', 'consulting'])],
    searchTerms: ['consultant', 'consulting firm', 'business consultant', 'management consultant'],
    aliases: ['consultant', 'consultants', 'consulting', 'consulting firm', 'business consultant', 'management consultant'],
  },

  // Religious / community / public
  churches: {
    key: 'churches',
    label: 'Churches',
    tagClauses: ['["amenity"="place_of_worship"]["religion"="christian"]'],
    searchTerms: ['church', 'christian church', 'cathedral', 'chapel'],
    aliases: ['church', 'churches', 'cathedral', 'chapel'],
  },

  mosques: {
    key: 'mosques',
    label: 'Mosques',
    tagClauses: ['["amenity"="place_of_worship"]["religion"="muslim"]'],
    searchTerms: ['mosque', 'masjid', 'islamic center'],
    aliases: ['mosque', 'mosques', 'masjid', 'islamic center'],
  },

  temples: {
    key: 'temples',
    label: 'Temples',
    tagClauses: ['["amenity"="place_of_worship"]["religion"~"hindu|buddhist|jain",i]'],
    searchTerms: ['temple', 'hindu temple', 'buddhist temple', 'jain temple'],
    aliases: ['temple', 'temples', 'hindu temple', 'buddhist temple', 'jain temple'],
  },
};

const aliasToCategoryKey: Record<string, keyof typeof categoryProfiles> = Object.entries(categoryProfiles).reduce(
  (acc, [profileKey, profile]) => {
    const normalizedProfileKey = normalizeText(profileKey);
    const singularProfileKey = singularize(normalizedProfileKey);

    acc[normalizedProfileKey] = profileKey;
    acc[singularProfileKey] = profileKey;

    acc[normalizeText(profile.label)] = profileKey;
    acc[singularize(normalizeText(profile.label))] = profileKey;

    profile.searchTerms.forEach((term) => {
      acc[normalizeText(term)] = profileKey;
      acc[singularize(normalizeText(term))] = profileKey;
    });

    profile.aliases?.forEach((alias) => {
      acc[normalizeText(alias)] = profileKey;
      acc[singularize(normalizeText(alias))] = profileKey;
    });

    return acc;
  },
  {} as Record<string, keyof typeof categoryProfiles>,
);

const getPartialMatch = (normalized: string): keyof typeof categoryProfiles | undefined => {
  const normalizedSingular = singularize(normalized);

  for (const [alias, profileKey] of Object.entries(aliasToCategoryKey)) {
    if (normalizedSingular === alias) return profileKey;

    const aliasWords = alias.split(' ');
    const inputWords = normalizedSingular.split(' ');

    const isStrongAlias =
      aliasWords.length >= 2 &&
      inputWords.length >= 2 &&
      (normalizedSingular.includes(alias) || alias.includes(normalizedSingular));

    if (isStrongAlias) {
      return profileKey;
    }
  }

  return undefined;
};

const createFallbackProfile = (companyType: string): CategoryProfile => {
  const cleaned = companyType.trim();
  const normalized = normalizeText(cleaned);

  const fallbackTerms = normalized
    .split(' ')
    .filter((term) => term.length > 2)
    .slice(0, 6);

  const fallbackClause = fallbackTerms.length
    ? makeNameRegexClause(fallbackTerms)
    : makeNameRegexClause([cleaned]);

  return {
    key: 'keyword-fallback',
    label: cleaned || 'Unknown Category',
    tagClauses: [fallbackClause],
    searchTerms: [cleaned].filter(Boolean),
    warnings: [
      {
        providerId: 'osm-category-map',
        providerName: 'OSM Category Map',
        message: `Using a fallback name match for "${cleaned}". Coverage may be sparse. Add this category to categoryProfiles for stronger OSM matching.`,
      },
    ],
  };
};

export const resolveCategoryProfile = (companyType: string): CategoryProfile => {
  const cleaned = companyType.trim();

  if (!cleaned) {
    return {
      key: 'empty-category',
      label: 'Unknown Category',
      tagClauses: [],
      searchTerms: [],
      warnings: [
        {
          providerId: 'osm-category-map',
          providerName: 'OSM Category Map',
          message: 'No company type was provided. Search coverage will be unavailable.',
        },
      ],
    };
  }

  const normalized = normalizeText(cleaned);
  const singularNormalized = singularize(normalized);

  const exactKey =
    aliasToCategoryKey[normalized] ??
    aliasToCategoryKey[singularNormalized] ??
    categoryProfiles[normalized]?.key;

  if (exactKey && categoryProfiles[exactKey]) {
    const exact = categoryProfiles[exactKey];

    return {
      key: exact.key,
      label: exact.label,
      tagClauses: exact.tagClauses,
      searchTerms: exact.searchTerms.length ? exact.searchTerms : [exact.label],
      warnings: [],
    };
  }

  const partialKey = getPartialMatch(normalized);

  if (partialKey && categoryProfiles[partialKey]) {
    const partial = categoryProfiles[partialKey];

    return {
      key: partial.key,
      label: partial.label,
      tagClauses: partial.tagClauses,
      searchTerms: partial.searchTerms.length ? partial.searchTerms : [partial.label],
      warnings: [
        {
          providerId: 'osm-category-map',
          providerName: 'OSM Category Map',
          message: `Mapped "${cleaned}" to "${partial.label}" using synonym/partial matching.`,
        },
      ],
    };
  }

  return createFallbackProfile(cleaned);
};

export const getSupportedCategories = (): CategoryProfile[] => {
  return Object.values(categoryProfiles).map((profile) => ({
    key: profile.key,
    label: profile.label,
    tagClauses: profile.tagClauses,
    searchTerms: profile.searchTerms,
    warnings: [],
  }));
};