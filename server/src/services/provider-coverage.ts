import type { ProviderCoverage, SearchProgress } from '../types/search';

const mergeStatus = (
  current: ProviderCoverage['status'],
  incoming: ProviderCoverage['status'],
  leadCount: number,
): ProviderCoverage['status'] => {
  const hasPartial = current === 'partial' || incoming === 'partial';
  const hasReturned = current === 'returned' || incoming === 'returned' || leadCount > 0;
  const hasFailed = current === 'failed' || incoming === 'failed';

  if (hasPartial || (hasReturned && hasFailed)) return 'partial';
  if (hasReturned) return 'returned';
  if (incoming === 'failed' || current === 'failed') return 'failed';
  if (incoming === 'configured' || current === 'configured') return 'configured';
  return 'not_configured';
};

const mergeMessage = (current: string | undefined, incoming: string | undefined) => {
  const messages = [...new Set([current, incoming].filter((value): value is string => Boolean(value?.trim())))];
  if (!messages.length) return undefined;

  const visibleMessages = messages.slice(0, 3);
  return `${visibleMessages.join(' ')}${messages.length > visibleMessages.length ? ' Additional provider observations were omitted.' : ''}`;
};

export const mergeProviderCoverage = (
  current: ProviderCoverage[] | undefined,
  incoming: ProviderCoverage[],
) => {
  const entries = new Map<string, ProviderCoverage>();

  for (const entry of current ?? []) {
    entries.set(entry.providerId, { ...entry, leadCount: Math.max(0, entry.leadCount) });
  }

  for (const entry of incoming) {
    const previous = entries.get(entry.providerId);
    if (!previous) {
      entries.set(entry.providerId, { ...entry, leadCount: Math.max(0, entry.leadCount) });
      continue;
    }

    const leadCount = previous.leadCount + Math.max(0, entry.leadCount);
    entries.set(entry.providerId, {
      providerId: entry.providerId,
      providerName: entry.providerName || previous.providerName,
      status: mergeStatus(previous.status, entry.status, leadCount),
      leadCount,
      message: mergeMessage(previous.message, entry.message),
    });
  }

  return [...entries.values()];
};

export const recordProviderCoverage = (
  progress: SearchProgress,
  entries: ProviderCoverage[],
) => {
  progress.providerCoverage = mergeProviderCoverage(progress.providerCoverage, entries);
};
