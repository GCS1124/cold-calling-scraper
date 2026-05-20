import type { Lead } from '../types/lead';

const companySuffixPattern =
  /\b(private limited|pvt ltd|pvt\. ltd\.|private ltd|ltd|limited|llc|inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.)\b/gi;

const canonicalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(companySuffixPattern, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const pickValue = (...values: Array<string | undefined>) =>
  values.find((value) => Boolean(value?.trim())) ?? '';

const toDomain = (value?: string) => {
  if (!value?.trim()) {
    return '';
  }

  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return '';
  }
};

const toPhoneKey = (value?: string) => {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }

  return digits.length === 10 ? digits : '';
};

const mergeGroup = (group: Lead[]) => {
  const sorted = [...group].sort((left, right) => right.confidence - left.confidence);
  const shortestNamed = [...group].sort((left, right) => left.name.length - right.name.length)[0];
  const sources = [...new Set(group.map((lead) => lead.source))];

  return {
    ...sorted[0],
    name: shortestNamed.name,
    mobile: pickValue(...sorted.map((lead) => lead.mobile)),
    email: pickValue(...sorted.map((lead) => lead.email)),
    website: pickValue(...sorted.map((lead) => lead.website)),
    address: pickValue(...sorted.map((lead) => lead.address)),
    source: sources.join(', '),
    confidence: Math.max(...sorted.map((lead) => lead.confidence)),
    hasEmail: sorted.some((lead) => lead.hasEmail),
    hasPhone: sorted.some((lead) => lead.hasPhone),
    hasWebsite: sorted.some((lead) => lead.hasWebsite),
    verifiedEmail: sorted.some((lead) => lead.verifiedEmail),
    verifiedPhone: sorted.some((lead) => lead.verifiedPhone),
  };
};

export const deduplicateLeads = (leads: Lead[]) => {
  const groups: Lead[][] = [];

  for (const lead of leads) {
    const domain = toDomain(lead.website);
    const phone = toPhoneKey(lead.mobile);
    const nameKey = canonicalizeName(lead.name);
    const cityKey = lead.city.toLowerCase();
    const matchingGroup = groups.find((group) =>
      group.some((candidate) => {
        const candidateDomain = toDomain(candidate.website);
        const candidatePhone = toPhoneKey(candidate.mobile);
        const candidateNameKey = canonicalizeName(candidate.name);
        const candidateCityKey = candidate.city.toLowerCase();

        return (
          (domain && candidateDomain && domain === candidateDomain) ||
          (phone && candidatePhone && phone === candidatePhone) ||
          (nameKey && candidateNameKey && cityKey === candidateCityKey && nameKey === candidateNameKey)
        );
      }),
    );

    if (matchingGroup) {
      matchingGroup.push(lead);
    } else {
      groups.push([lead]);
    }
  }

  return groups.map(mergeGroup);
};
