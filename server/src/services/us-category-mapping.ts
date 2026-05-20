import type { ProviderWarning } from '../types/search';

export type CategoryProfile = {
  key: string;
  label: string;
  tagClauses: string[];
  warnings: ProviderWarning[];
};

const categoryProfiles: Record<string, Omit<CategoryProfile, 'warnings'>> = {
  'dental clinics': {
    key: 'dental-clinics',
    label: 'Dental Clinics',
    tagClauses: ['["amenity"="dentist"]', '["healthcare"="dentist"]'],
  },
  plumbers: {
    key: 'plumbers',
    label: 'Plumbers',
    tagClauses: ['["craft"="plumber"]'],
  },
  'roofing contractors': {
    key: 'roofing-contractors',
    label: 'Roofing Contractors',
    tagClauses: ['["craft"="roofer"]'],
  },
  'hvac contractors': {
    key: 'hvac-contractors',
    label: 'HVAC Contractors',
    tagClauses: ['["craft"="hvac"]', '["craft"="heating_engineer"]'],
  },
  'real estate agencies': {
    key: 'real-estate-agencies',
    label: 'Real Estate Agencies',
    tagClauses: ['["office"="estate_agent"]'],
  },
  'law firms': {
    key: 'law-firms',
    label: 'Law Firms',
    tagClauses: ['["office"="lawyer"]'],
  },
  'medical clinics': {
    key: 'medical-clinics',
    label: 'Medical Clinics',
    tagClauses: ['["amenity"="clinic"]', '["healthcare"="clinic"]'],
  },
  'auto repair': {
    key: 'auto-repair',
    label: 'Auto Repair',
    tagClauses: ['["shop"="car_repair"]', '["craft"="car_repair"]'],
  },
  'marketing agencies': {
    key: 'marketing-agencies',
    label: 'Marketing Agencies',
    tagClauses: ['["office"="advertising_agency"]', '["office"="company"]["name"~"marketing",i]'],
  },
  'saas agencies': {
    key: 'saas-agencies',
    label: 'SaaS Agencies',
    tagClauses: ['["office"="it"]', '["office"="company"]["name"~"software|saas|tech",i]'],
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
};

export const resolveCategoryProfile = (companyType: string): CategoryProfile => {
  const normalized = companyType.trim().toLowerCase();
  const resolvedKey = categoryAliases[normalized] ?? normalized;
  const exact = categoryProfiles[resolvedKey];

  if (exact) {
    return {
      ...exact,
      warnings: [],
    };
  }

  return {
    key: 'keyword-fallback',
    label: companyType.trim(),
    tagClauses: [`["name"~"${companyType.trim().replace(/"/g, '\\"')}",i]`],
    warnings: [
      {
        providerId: 'osm-category-map',
        providerName: 'OSM Category Map',
        message: `Using a fallback name match for "${companyType.trim()}". Coverage may be sparse.`,
      },
    ],
  };
};
