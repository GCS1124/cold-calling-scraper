import type { Lead } from '../types/lead';

const companySuffixPattern =
  /\b(private limited|pvt ltd|pvt\. ltd\.|private ltd|ltd|limited|llc|inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.)\b/gi;

const canonicalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(companySuffixPattern, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeText = (value?: string) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

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

const buildIdentityKeys = (lead: Lead) => {
  const keys: string[] = [];
  const domain = toDomain(lead.website);
  const phone = toPhoneKey(lead.mobile);
  const nameKey = canonicalizeName(lead.name);
  const cityKey = normalizeText(lead.city);

  if (domain) {
    keys.push(`domain:${domain}`);
  }

  if (phone) {
    keys.push(`phone:${phone}`);
  }

  if (nameKey && cityKey) {
    keys.push(`name-city:${nameKey}|${cityKey}`);
  }

  return keys;
};

const mergeGroup = (group: Lead[]) => {
  const sorted = [...group].sort((left, right) => right.confidence - left.confidence);
  const shortestNamed = [...group].sort((left, right) => left.name.length - right.name.length)[0] ?? sorted[0];
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
    rejectionReason:
      sorted.find((lead) => lead.rejectionReason === 'blocked_website')?.rejectionReason ??
      sorted.find((lead) => lead.rejectionReason === 'blocked_google')?.rejectionReason ??
      sorted.find((lead) => lead.rejectionReason)?.rejectionReason,
    crawlAttempts: Math.max(...group.map((lead) => lead.crawlAttempts ?? 0)),
  };
};

export const deduplicateLeads = (leads: Lead[]) => {
  if (leads.length <= 1) {
    return [...leads];
  }

  const parent = leads.map((_, index) => index);

  const find = (index: number): number => {
    if (parent[index] !== index) {
      parent[index] = find(parent[index]);
    }

    return parent[index] ?? index;
  };

  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);

    if (leftRoot === rightRoot) {
      return;
    }

    if (leftRoot < rightRoot) {
      parent[rightRoot] = leftRoot;
      return;
    }

    parent[leftRoot] = rightRoot;
  };

  const firstSeenByKey = new Map<string, number>();

  leads.forEach((lead, index) => {
    for (const key of buildIdentityKeys(lead)) {
      const existingIndex = firstSeenByKey.get(key);

      if (existingIndex === undefined) {
        firstSeenByKey.set(key, index);
        continue;
      }

      union(index, existingIndex);
    }
  });

  const groups = new Map<number, Lead[]>();

  leads.forEach((lead, index) => {
    const root = find(index);
    const group = groups.get(root);

    if (group) {
      group.push(lead);
      return;
    }

    groups.set(root, [lead]);
  });

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => mergeGroup(group));
};
