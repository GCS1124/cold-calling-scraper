import type { ProviderWarning } from '../types/search';

export type CategoryProfile = {
  key: string;
  label: string;
  tagClauses: string[];
  searchTerms: string[];
  warnings: ProviderWarning[];
};

const categoryProfiles: Record<string, Omit<CategoryProfile, 'warnings'>> = {
  'dental clinics': {
    key: 'dental-clinics',
    label: 'Dental Clinics',
    tagClauses: ['["amenity"="dentist"]', '["healthcare"="dentist"]'],
    searchTerms: ['dentist', 'dental office'],
  },
  plumbers: {
    key: 'plumbers',
    label: 'Plumbers',
    tagClauses: ['["craft"="plumber"]'],
    searchTerms: ['plumber', 'plumbing company'],
  },
  'roofing contractors': {
    key: 'roofing-contractors',
    label: 'Roofing Contractors',
    tagClauses: ['["craft"="roofer"]'],
    searchTerms: ['roofer', 'roofing company'],
  },
  'hvac contractors': {
    key: 'hvac-contractors',
    label: 'HVAC Contractors',
    tagClauses: ['["craft"="hvac"]', '["craft"="heating_engineer"]'],
    searchTerms: ['hvac', 'air conditioning', 'heating contractor'],
  },
  'real estate agencies': {
    key: 'real-estate-agencies',
    label: 'Real Estate Agencies',
    tagClauses: ['["office"="estate_agent"]'],
    searchTerms: ['real estate agency', 'realtor', 'property management'],
  },
  'law firms': {
    key: 'law-firms',
    label: 'Law Firms',
    tagClauses: ['["office"="lawyer"]'],
    searchTerms: ['lawyer', 'attorney', 'law office'],
  },
  'medical clinics': {
    key: 'medical-clinics',
    label: 'Medical Clinics',
    tagClauses: ['["amenity"="clinic"]', '["healthcare"="clinic"]'],
    searchTerms: ['medical clinic', 'health clinic', 'urgent care'],
  },
  'auto repair': {
    key: 'auto-repair',
    label: 'Auto Repair',
    tagClauses: ['["shop"="car_repair"]', '["craft"="car_repair"]'],
    searchTerms: ['auto repair shop', 'car repair', 'mechanic'],
  },
  'marketing agencies': {
    key: 'marketing-agencies',
    label: 'Marketing Agencies',
    tagClauses: ['["office"="advertising_agency"]', '["office"="company"]["name"~"marketing",i]'],
    searchTerms: ['marketing agency', 'digital marketing', 'advertising agency'],
  },
  'saas agencies': {
    key: 'saas-agencies',
    label: 'SaaS Agencies',
    tagClauses: ['["office"="it"]', '["office"="company"]["name"~"software|saas|tech",i]'],
    searchTerms: ['software company', 'tech company', 'it services'],
  },
  'cleaning services': {
    key: 'cleaning-services',
    label: 'Cleaning Services',
    tagClauses: [
      '["office"="cleaning_company"]',
      '["office"="company"]["name"~"cleaning|janitorial|maid|house cleaning",i]',
    ],
    searchTerms: [
      'cleaning service',
      'cleaning company',
      'janitorial services',
      'maid service',
      'house cleaning',
      'commercial cleaning',
    ],
  },
};

const categoryAliases: Record<string, keyof typeof categoryProfiles> = {
  dentist: 'dental clinics',
  'dental clinic': 'dental clinics',
  'dental office': 'dental clinics',
  roofer: 'roofing contractors',
  'roofing company': 'roofing contractors',
  hvac: 'hvac contractors',
  'air conditioning': 'hvac contractors',
  'heating repair': 'hvac contractors',
  lawyer: 'law firms',
  attorney: 'law firms',
  'law firm': 'law firms',
  'medical clinic': 'medical clinics',
  'car repair': 'auto repair',
  'auto repair shop': 'auto repair',
  'marketing agency': 'marketing agencies',
  'software agency': 'saas agencies',
  'cleaning service': 'cleaning services',
  'cleaning company': 'cleaning services',
  'janitorial service': 'cleaning services',
  'janitorial services': 'cleaning services',
  'house cleaning': 'cleaning services',
  'maid service': 'cleaning services',
};

export const resolveCategoryProfile = (companyType: string): CategoryProfile => {
  const normalized = companyType.trim().toLowerCase();
  const resolvedKey = categoryAliases[normalized] ?? normalized;
  const exact = categoryProfiles[resolvedKey];

  if (exact) {
    return {
      ...exact,
      searchTerms: exact.searchTerms.length ? exact.searchTerms : [exact.label],
      warnings: [],
    };
  }

  return {
    key: 'keyword-fallback',
    label: companyType.trim(),
    tagClauses: [`["name"~"${companyType.trim().replace(/"/g, '\\"')}",i]`],
    searchTerms: [companyType.trim()],
    warnings: [
      {
        providerId: 'osm-category-map',
        providerName: 'OSM Category Map',
        message: `Using a fallback name match for "${companyType.trim()}". Coverage may be sparse.`,
      },
    ],
  };
};
