import type { CategoryProfile } from './us-category-mapping';
import { usStateNames, type UsStateCode } from '../data/us-states';
import type { NormalizedUsLocation } from './us-location';

const serviceSynonyms: Record<string, string[]> = {
  'dental clinics': ['dentist', 'dental office', 'orthodontist', 'periodontist'],
  plumbers: ['plumber', 'plumbing service', 'plumbing company'],
  'roofing contractors': ['roofer', 'roofing company', 'roofing service'],
  'hvac contractors': ['hvac', 'air conditioning', 'heating repair', 'heating and cooling'],
  'real estate agencies': ['real estate', 'real estate agent', 'realtor', 'property management'],
  'law firms': ['law firm', 'attorney', 'lawyer', 'legal services'],
  'medical clinics': ['medical clinic', 'clinic', 'doctor', 'urgent care'],
  'auto repair': ['auto repair shop', 'car repair', 'mechanic', 'auto service'],
  'marketing agencies': ['marketing agency', 'digital marketing', 'advertising agency', 'seo agency'],
  'saas agencies': ['software company', 'software agency', 'tech company', 'it services'],
  'cleaning services': ['cleaning service', 'cleaning company', 'janitorial service', 'house cleaning'],
};

const normalizeQueryPart = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

const unique = (values: string[]) =>
  [...new Set(values.map(normalizeQueryPart).filter(Boolean))];

const buildQueryForms = (categoryTerm: string, locationTerm: string) => [
  `${categoryTerm} in ${locationTerm}`,
  `${categoryTerm} ${locationTerm}`,
  `${categoryTerm} near ${locationTerm}`,
];

const replaceTokens = (value: string, replacements: Array<[RegExp, string[]]>) => {
  const variants = new Set<string>();
  variants.add(value);

  for (const [pattern, options] of replacements) {
    if (pattern.test(value)) {
      for (const option of options) {
        variants.add(value.replace(pattern, option));
      }
    }
  }

  return [...variants];
};

const buildCategoryTerms = (companyType: string, profile: CategoryProfile) => {
  const normalized = companyType.trim();
  const normalizedKey = normalized.toLowerCase();
  const profileKey = profile.label.trim().toLowerCase();
  const terms = new Set<string>();

  if (normalized) {
    terms.add(normalized);
  }
  if (profile.label && profile.label.trim()) {
    terms.add(profile.label.trim());
  }

  for (const synonym of serviceSynonyms[normalizedKey] ?? []) {
    terms.add(synonym);
  }
  for (const synonym of serviceSynonyms[profileKey] ?? []) {
    terms.add(synonym);
  }

  const profileTerms = unique(profile.searchTerms ?? []);
  for (const term of profileTerms) {
    terms.add(term);
  }

  const genericVariants = replaceTokens(normalized, [
    [/\bservices?\b/i, ['service', 'services', 'company', 'business']],
    [/\bagencies?\b/i, ['agency', 'agencies', 'firm']],
    [/\bcompanies\b/i, ['company', 'companies']],
    [/\bfirms?\b/i, ['firm', 'firms', 'company']],
    [/\bclinics?\b/i, ['clinic', 'clinics', 'office']],
    [/\bcontractors?\b/i, ['contractor', 'contractors', 'services']],
  ]);

  for (const variant of genericVariants) {
    terms.add(variant);
  }

  return unique([...terms]).slice(0, 10);
};

const buildLocationTerms = (location: NormalizedUsLocation) => {
  if (location.mode === 'nationwide') {
    return ['United States'];
  }

  const normalizedCity = location.city.trim();
  const normalizedLabel = location.label.trim();
  const isCityStateLocal = location.mode === 'local' && normalizedLabel.includes(',');

  if (isCityStateLocal) {
    const city = normalizedCity || normalizedLabel.split(',')[0]?.trim() || normalizedLabel;
    const stateName = location.stateCode ? usStateNames[location.stateCode as UsStateCode] : '';

    return unique([
      normalizedLabel,
      city,
      `${city}, ${location.stateCode}`,
      `${city} ${location.stateCode}`,
      stateName ? `${city}, ${stateName}` : '',
      stateName ? `${city} ${stateName}` : '',
      `${city} area`,
      `greater ${city}`,
      `${city} metro`,
      `${city} metro area`,
      `downtown ${city}`,
      `central ${city}`,
      `north ${city}`,
      `south ${city}`,
      `east ${city}`,
      `west ${city}`,
    ]).slice(0, 13);
  }

  const variants = [
    normalizedLabel,
    location.city && location.stateCode ? `${location.city} ${location.stateCode}` : '',
    location.city && location.stateCode ? `${location.city}, ${location.stateCode}` : '',
    location.city && location.city !== normalizedLabel ? location.city : '',
    location.stateCode,
  ];

  return unique(variants).slice(0, 5);
};

export const buildDiscoveryQueryVariants = (
  companyType: string,
  location: NormalizedUsLocation,
  profile: CategoryProfile,
) => {
  const categoryTerms = buildCategoryTerms(companyType, profile);
  const locationTerms = buildLocationTerms(location);
  const queries: string[] = [];
  const seen = new Set<string>();
  const maxLayer = categoryTerms.length + locationTerms.length - 2;

  for (let layer = 0; layer <= maxLayer; layer += 1) {
    for (let categoryIndex = 0; categoryIndex < categoryTerms.length; categoryIndex += 1) {
      const locationIndex = layer - categoryIndex;
      if (locationIndex < 0 || locationIndex >= locationTerms.length) {
        continue;
      }

      const categoryTerm = categoryTerms[categoryIndex] ?? '';
      const locationTerm = locationTerms[locationIndex] ?? '';

      for (const query of buildQueryForms(categoryTerm, locationTerm)) {
        const key = query.toLowerCase();
        if (!key || seen.has(key)) {
          continue;
        }

        seen.add(key);
        queries.push(query);
      }
    }
  }

  if (location.mode !== 'nationwide' && location.city && location.city !== location.label) {
    queries.push(`${categoryTerms[0] ?? companyType.trim()} near ${location.city}`);
    queries.push(`${categoryTerms[0] ?? companyType.trim()} in ${location.city}`);
  }

  return unique(queries).slice(0, location.mode === 'local' && location.label.includes(',') ? 60 : 24);
};
