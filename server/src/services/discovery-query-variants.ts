import type { CategoryProfile } from './us-category-mapping';
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
  const terms = new Set<string>();

  if (normalized) {
    terms.add(normalized);
  }
  if (profile.label && profile.label.trim()) {
    terms.add(profile.label.trim());
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

  return unique([...terms]).slice(0, 4);
};

const buildLocationTerms = (location: NormalizedUsLocation) => {
  if (location.mode === 'nationwide') {
    return ['United States'];
  }

  const variants = [
    location.label,
    location.city && location.city !== location.label ? location.city : '',
    location.stateCode,
  ];

  return unique(variants).slice(0, 2);
};

export const buildDiscoveryQueryVariants = (
  companyType: string,
  location: NormalizedUsLocation,
  profile: CategoryProfile,
) => {
  const categoryTerms = buildCategoryTerms(companyType, profile);
  const locationTerms = buildLocationTerms(location);
  const queries: string[] = [];

  for (const categoryTerm of categoryTerms) {
    for (const locationTerm of locationTerms) {
      queries.push(`${categoryTerm} in ${locationTerm}`);
    }
  }

  if (location.mode !== 'nationwide' && location.city && location.city !== location.label) {
    queries.push(`${categoryTerms[0] ?? companyType.trim()} near ${location.city}`);
  }

  return unique(queries).slice(0, 6);
};
