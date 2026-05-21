import type { CategoryProfile } from './us-category-mapping';

const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

const queryTemplates = (term: string, locationLabel: string) => [
  `${term} in ${locationLabel}`,
  `${term} ${locationLabel}`,
  `${term} near ${locationLabel}`,
];

export const buildDiscoveryQueries = (
  companyType: string,
  locationLabel: string,
  profile: CategoryProfile,
) => {
  const baseTerms = unique([
    companyType,
    profile.label,
    ...(profile.searchTerms ?? []),
  ]);

  const queries = new Set<string>();

  for (const term of baseTerms) {
    for (const query of queryTemplates(term, locationLabel)) {
      queries.add(query);
      if (queries.size >= 6) {
        return [...queries];
      }
    }
  }

  if (!queries.size) {
    queries.add(`${companyType} in ${locationLabel}`);
  }

  return [...queries];
};
