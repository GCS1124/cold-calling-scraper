import type { SearchResponse } from '../types/lead';

export type DisplayProviderWarning = SearchResponse['meta']['providerWarnings'][number];

const publicSearchEnginePattern = /^(?:brave search|bing|duckduckgo|yahoo search)$/i;

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

const warningSeverity = (warning: DisplayProviderWarning): NonNullable<DisplayProviderWarning['severity']> => {
  if (warning.severity) return warning.severity;

  // Older snapshots did not include severity. Treat an explicitly handled
  // fallback as informational, while keeping unexplained failures actionable.
  return /continued|preserved|not promoted|not configured|unavailable for part|paused after repeated failures|no unverified|no access challenge|timed out|quota|rate.?limit/i.test(
    warning.message,
  )
    ? 'info'
    : 'warning';
};

const severityRank: Record<NonNullable<DisplayProviderWarning['severity']>, number> = {
  info: 1,
  warning: 2,
  error: 3,
};

const contextForProviderId = (providerId: string) => {
  const normalized = normalize(providerId);
  if (normalized.startsWith('notarycafe-indexed-search-')) return 'indexed NotaryCafe';
  if (normalized.startsWith('linkedin-search-')) return 'public LinkedIn';
  return 'public discovery';
};

/**
 * Make provider health readable without deleting evidence of a real failure.
 * Search-engine circuit-breaker messages are emitted once per discovery path;
 * one compact row is enough when the same engine failed in multiple paths.
 */
export const normalizeProviderWarningsForDisplay = (
  warnings: DisplayProviderWarning[],
) => {
  const groups = new Map<string, DisplayProviderWarning[]>();

  for (const warning of Array.isArray(warnings) ? warnings : []) {
    if (!warning || typeof warning.providerId !== 'string' || typeof warning.message !== 'string') {
      continue;
    }

    const normalizedWarning = {
      ...warning,
      severity: warningSeverity(warning),
    } satisfies DisplayProviderWarning;
    const providerKey = normalize(warning.providerName);
    const isSearchEngine = publicSearchEnginePattern.test(providerKey);
    const key = isSearchEngine
      ? `search-engine:${providerKey}`
      : `warning:${normalize(warning.providerId)}:${normalize(warning.message)}`;
    groups.set(key, [...(groups.get(key) ?? []), normalizedWarning]);
  }

  return [...groups.values()].map((group) => {
    const first = group[0]!;
    if (group.length === 1 || !publicSearchEnginePattern.test(normalize(first.providerName))) {
      return first;
    }

    const severity = group.reduce<NonNullable<DisplayProviderWarning['severity']>>(
      (current, warning) =>
        severityRank[warning.severity!] > severityRank[current] ? warning.severity! : current,
      'info',
    );
    const contexts = [...new Set(group.map((warning) => contextForProviderId(warning.providerId)))];
    const latest = group[group.length - 1]!;

    return {
      ...first,
      severity,
      message:
        `Encountered ${group.length} handled ${first.providerName} status update${group.length === 1 ? '' : 's'} ` +
        `across ${contexts.join(' and ')}. ${latest.message}`,
    } satisfies DisplayProviderWarning;
  });
};
