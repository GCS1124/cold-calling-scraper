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
    searchTerms: [
      'dentist',
      'dental office',
      'dental clinic',
      'orthodontist',
      'periodontist',
      'oral surgeon',
      'cosmetic dentist',
    ],
  },
  plumbers: {
    key: 'plumbers',
    label: 'Plumbers',
    tagClauses: ['["craft"="plumber"]'],
    searchTerms: [
      'plumber',
      'plumbing company',
      'plumbing service',
      'emergency plumber',
      'drain cleaning',
      'water heater repair',
    ],
  },
  'roofing contractors': {
    key: 'roofing-contractors',
    label: 'Roofing Contractors',
    tagClauses: ['["craft"="roofer"]'],
    searchTerms: ['roofer', 'roofing company', 'roof repair', 'roof replacement', 'roof inspection'],
  },
  'hvac contractors': {
    key: 'hvac-contractors',
    label: 'HVAC Contractors',
    tagClauses: ['["craft"="hvac"]', '["craft"="heating_engineer"]'],
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
  },
  'real estate agencies': {
    key: 'real-estate-agencies',
    label: 'Real Estate Agencies',
    tagClauses: ['["office"="estate_agent"]'],
    searchTerms: ['real estate agency', 'real estate agent', 'realtor', 'broker', 'property management'],
  },
  'law firms': {
    key: 'law-firms',
    label: 'Law Firms',
    tagClauses: ['["office"="lawyer"]'],
    searchTerms: ['lawyer', 'attorney', 'law office', 'legal services', 'personal injury lawyer'],
  },
  'medical clinics': {
    key: 'medical-clinics',
    label: 'Medical Clinics',
    tagClauses: ['["amenity"="clinic"]', '["healthcare"="clinic"]'],
    searchTerms: ['medical clinic', 'health clinic', 'urgent care', 'doctor office', 'family medicine'],
  },
  'auto repair': {
    key: 'auto-repair',
    label: 'Auto Repair',
    tagClauses: ['["shop"="car_repair"]', '["craft"="car_repair"]'],
    searchTerms: ['auto repair shop', 'car repair', 'mechanic', 'auto service', 'brake shop', 'tire shop'],
  },
  'marketing agencies': {
    key: 'marketing-agencies',
    label: 'Marketing Agencies',
    tagClauses: ['["office"="advertising_agency"]', '["office"="company"]["name"~"marketing",i]'],
    searchTerms: [
      'marketing agency',
      'digital marketing',
      'advertising agency',
      'seo agency',
      'social media marketing',
      'lead generation agency',
    ],
  },
  'saas agencies': {
    key: 'saas-agencies',
    label: 'SaaS Agencies',
    tagClauses: ['["office"="it"]', '["office"="company"]["name"~"software|saas|tech",i]'],
    searchTerms: ['software company', 'tech company', 'it services', 'software development', 'web development'],
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
      'commercial cleaner',
    ],
  },
};

const categoryAliases: Record<string, keyof typeof categoryProfiles> = {
  dentist: 'dental clinics',
  'dental clinic': 'dental clinics',
  'dental office': 'dental clinics',
  orthodontist: 'dental clinics',
  periodontist: 'dental clinics',
  'oral surgeon': 'dental clinics',
  'cosmetic dentist': 'dental clinics',
  roofer: 'roofing contractors',
  'roofing company': 'roofing contractors',
  'roofing contractor': 'roofing contractors',
  'roof repair': 'roofing contractors',
  'roof replacement': 'roofing contractors',
  hvac: 'hvac contractors',
  'hvac contractor': 'hvac contractors',
  'air conditioning': 'hvac contractors',
  'air conditioning repair': 'hvac contractors',
  'ac repair': 'hvac contractors',
  'heating repair': 'hvac contractors',
  'heating contractor': 'hvac contractors',
  'furnace repair': 'hvac contractors',
  lawyer: 'law firms',
  attorney: 'law firms',
  'law firm': 'law firms',
  'legal services': 'law firms',
  'personal injury lawyer': 'law firms',
  'family law attorney': 'law firms',
  'medical clinic': 'medical clinics',
  'health clinic': 'medical clinics',
  'urgent care': 'medical clinics',
  'doctor office': 'medical clinics',
  'family medicine': 'medical clinics',
  'car repair': 'auto repair',
  'auto repair shop': 'auto repair',
  mechanic: 'auto repair',
  'auto service': 'auto repair',
  'marketing agency': 'marketing agencies',
  'digital marketing': 'marketing agencies',
  'advertising agency': 'marketing agencies',
  'seo agency': 'marketing agencies',
  'social media marketing': 'marketing agencies',
  'software agency': 'saas agencies',
  'software company': 'saas agencies',
  'tech company': 'saas agencies',
  'it services': 'saas agencies',
  'software development': 'saas agencies',
  'web development': 'saas agencies',
  'cleaning service': 'cleaning services',
  'cleaning company': 'cleaning services',
  'janitorial service': 'cleaning services',
  'janitorial services': 'cleaning services',
  'house cleaning': 'cleaning services',
  'maid service': 'cleaning services',
  'commercial cleaning': 'cleaning services',
  'commercial cleaner': 'cleaning services',
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
