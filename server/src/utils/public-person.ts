export type PublicDecisionMaker = {
  name: string;
  role?: string;
};

const roleExpression =
  'chief executive officer|chief operating officer|practice administrator|managing member|general manager|co-founder|founder|owner|ceo|coo|president|principal|partner|director|manager|operator|proprietor|administrator|head';

export const publicDecisionMakerRolePattern = new RegExp(
  '\\b(?:' + roleExpression + ')\\b',
  'i',
);

const credentialPattern =
  /(?:^|\s)(?:dr|mr|mrs|ms|dds|dmd|md|do|rn|esq|jd|phd)\.?(?=\s|$)/gi;
const businessNamePattern =
  /\b(?:llc|l\.?t\.?d|inc\.?|incorporated|corp\.?|corporation|company|clinic|studio|group|services|solutions|systems|agency|practice|medical|health|dental|dentistry|hvac|plumbing|roofing|construction|realty|attorneys?|auto|electric|cleaning|consulting|business)\b/i;
const nonPersonPhrasePattern =
  /\b(?:with us|for us|contact us|call us|join us|meet (?:our|the) team|our team|our staff|about us|learn more|read more|click here|reach out)\b/i;

const normalizeWhitespace = (value: string) =>
  value
    .replace(/[|•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasPublicNameCapitalization = (value: string) =>
  normalizeWhitespace(value)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => /^[A-Z][\p{L}'’.-]*$/u.test(word));

export const normalizePublicPersonName = (value?: string) => {
  const normalized = normalizeWhitespace(value ?? '')
    .replace(/^(?:name|owner|founder|co-founder|ceo|president|principal|partner|director|manager|operator|administrator|head)\s*(?:is|of|:|-|–|—)\s*/i, '')
    .replace(credentialPattern, ' ')
    .replace(/^[,;:()[\]{}]+|[,;:()[\]{}]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!isLikelyPublicPersonName(normalized)) {
    return '';
  }

  return normalized;
};

export const isLikelyPublicPersonName = (value?: string) => {
  const normalized = normalizeWhitespace(value ?? '')
    .replace(credentialPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized || normalized.length > 120 || /[@\d]|https?:|www\./i.test(normalized)) {
    return false;
  }

  if (
    publicDecisionMakerRolePattern.test(normalized) ||
    businessNamePattern.test(normalized) ||
    nonPersonPhrasePattern.test(normalized)
  ) {
    publicDecisionMakerRolePattern.lastIndex = 0;
    return false;
  }
  publicDecisionMakerRolePattern.lastIndex = 0;

  const words = normalized
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}'’.-]/gu, ''))
    .filter(Boolean);

  return (
    words.length >= 2 &&
    words.length <= 6 &&
    words.every((word) => {
      const letters = word.replace(/[.'’-]/g, '');
      return letters.length >= 2 && /\p{L}/u.test(letters);
    })
  );
};

export const normalizePublicPersonRole = (value?: string) => {
  const normalized = normalizeWhitespace(value ?? '').slice(0, 120);
  const match = normalized.match(publicDecisionMakerRolePattern);
  return match?.[0] ?? '';
};

const addMention = (
  mentions: Map<string, PublicDecisionMaker>,
  nameValue: string,
  roleValue: string,
) => {
  if (!hasPublicNameCapitalization(nameValue)) return;

  const name = normalizePublicPersonName(nameValue);
  if (!name) return;

  const key = name.toLocaleLowerCase();
  const role = normalizePublicPersonRole(roleValue);
  const current = mentions.get(key);
  mentions.set(key, {
    name: current?.name ?? name,
    ...(current?.role || role ? { role: current?.role ?? role } : {}),
  });
};

/** Extract only explicit role/name phrases; this never invents a person name. */
export const extractPublicDecisionMakerMentions = (value: string): PublicDecisionMaker[] => {
  const text = normalizeWhitespace(value);
  if (!text) return [];

  const nameExpression = "[A-Z][\\p{L}'’.-]{1,}(?:\\s+[A-Z][\\p{L}'’.-]{1,}){1,5}?";
  const mentions = new Map<string, PublicDecisionMaker>();
  const roleBeforeName = new RegExp(
    '\\b(' + roleExpression + ')\\b\\s*(?:is|:|-|–|—|,)?\\s+(' + nameExpression + ')',
    'giu',
  );
  const nameBeforeRole = new RegExp(
    '(' + nameExpression + ')\\s*(?:,|\\||•|-|–|—|\\bis\\b)?\\s+(' + roleExpression + ')\\b',
    'giu',
  );

  for (const match of text.matchAll(roleBeforeName)) {
    if (match[1] && match[2]) addMention(mentions, match[2], match[1]);
  }
  for (const match of text.matchAll(nameBeforeRole)) {
    if (match[1] && match[2]) addMention(mentions, match[1], match[2]);
  }

  return [...mentions.values()].slice(0, 12);
};
