const normalizeTerm = (value: string) =>
  value
    .trim()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*["'’`]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const unique = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values.map(normalizeTerm).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
};

export const buildQueryTermVariants = (value: string) => {
  const normalized = normalizeTerm(value);
  if (!normalized) {
    return [];
  }

  const words = normalized.split(' ');
  const lastWord = words.at(-1) ?? '';
  let singularLastWord = lastWord;

  if (/ies$/i.test(lastWord) && lastWord.length > 4) {
    singularLastWord = `${lastWord.slice(0, -3)}y`;
  } else if (/(?:ches|shes|sses|xes|zes)$/i.test(lastWord)) {
    singularLastWord = lastWord.slice(0, -2);
  } else if (
    /s$/i.test(lastWord) &&
    lastWord.length > 3 &&
    !/(?:ss|us|is|as|ws)$/i.test(lastWord)
  ) {
    singularLastWord = lastWord.slice(0, -1);
  }

  const singular =
    singularLastWord === lastWord
      ? normalized
      : [...words.slice(0, -1), singularLastWord].join(' ');

  return unique([normalized, singular]);
};
