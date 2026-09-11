import type { ProviderCoverage, SearchProgress } from '../types/search';

const countFields = [
  'attemptedCount',
  'observedCount',
  'acceptedCount',
  'reviewCount',
  'deferredCount',
  'completedCount',
  'enrichedCount',
  'blockedCount',
  'timedOutCount',
  'skippedCount',
  'decisionMakerRecoveredCount',
] as const;

type CountField = (typeof countFields)[number];
type ProviderCounts = Record<CountField, number>;

const asCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const hasStructuredCounts = (entry: ProviderCoverage) =>
  countFields.some((field) => entry[field] !== undefined);

const getAcceptedCount = (entry: ProviderCoverage) =>
  entry.acceptedCount === undefined ? asCount(entry.leadCount) : asCount(entry.acceptedCount);

const combineCount = (left: ProviderCoverage, right: ProviderCoverage, field: CountField) => {
  // Deferred work is a remaining-work snapshot, not a historical event. A
  // later durable tick must replace it (and a completed tick clears it), while
  // observations/attempts remain cumulative across independent ticks.
  if (field === 'deferredCount') {
    return right[field] === undefined ? asCount(left[field]) : asCount(right[field]);
  }

  return asCount(left[field]) + asCount(right[field]);
};

const outcomePriority: Record<NonNullable<ProviderCoverage['outcome']>, number> = {
  not_started: 0,
  empty: 1,
  filtered: 2,
  returned: 3,
  deferred: 4,
  timed_out: 5,
  rate_limited: 6,
  blocked: 7,
  failed: 8,
  not_configured: 9,
};

const isFailureOutcome = (outcome: ProviderCoverage['outcome']) =>
  outcome === 'timed_out' ||
  outcome === 'blocked' ||
  outcome === 'rate_limited' ||
  outcome === 'failed';

const mergeOutcome = (
  current: ProviderCoverage,
  incoming: ProviderCoverage,
  counts: ProviderCounts,
): ProviderCoverage['outcome'] | undefined => {
  // Legacy coverage did not distinguish execution state from a message. Keep
  // those records byte-for-byte compatible until at least one structured
  // observation enters the merge.
  if (!current.outcome && !incoming.outcome && !hasStructuredCounts(current) && !hasStructuredCounts(incoming)) {
    return undefined;
  }

  const outcomes = [current.outcome, incoming.outcome].filter(
    (value): value is NonNullable<ProviderCoverage['outcome']> => Boolean(value),
  );
  const failedOutcome = outcomes
    .filter(isFailureOutcome)
    .sort((left, right) => outcomePriority[right] - outcomePriority[left])[0];

  // A partial successful response that also timed out must stay visibly
  // degraded. Counts communicate what survived; outcome communicates why the
  // stage did not finish cleanly.
  if (failedOutcome) return failedOutcome;
  if (outcomes.includes('deferred') || counts.deferredCount > 0) return 'deferred';
  if (counts.acceptedCount > 0 || counts.observedCount > 0 || outcomes.includes('returned')) {
    return 'returned';
  }
  if (counts.reviewCount > 0 || outcomes.includes('filtered')) return 'filtered';
  if (outcomes.includes('empty') || counts.attemptedCount > 0) return 'empty';
  if (outcomes.includes('not_configured')) return 'not_configured';
  return 'not_started';
};

const mergePhase = (
  current: ProviderCoverage,
  incoming: ProviderCoverage,
  outcome: ProviderCoverage['outcome'],
): ProviderCoverage['phase'] | undefined => {
  if (!current.phase && !incoming.phase && !outcome) return undefined;
  if (outcome === 'not_configured') return 'skipped';
  if (isFailureOutcome(outcome)) return 'degraded';
  if (outcome === 'deferred') return 'queued';
  if (current.phase === 'running' || incoming.phase === 'running') return 'running';
  if (current.phase === 'queued' || incoming.phase === 'queued' || outcome === 'not_started') {
    return 'queued';
  }
  return 'completed';
};

const latestTimestamp = (left: string | undefined, right: string | undefined) => {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
};

const mergeStatus = (
  current: ProviderCoverage['status'],
  incoming: ProviderCoverage['status'],
  leadCount: number,
  outcome?: ProviderCoverage['outcome'],
  phase?: ProviderCoverage['phase'],
): ProviderCoverage['status'] => {
  if (outcome === 'not_configured') return 'not_configured';
  if (phase === 'degraded' || isFailureOutcome(outcome)) return 'partial';
  if (outcome === 'returned' || outcome === 'empty' || outcome === 'filtered') return 'returned';
  if (outcome === 'deferred' || outcome === 'not_started' || phase === 'queued' || phase === 'running') {
    return 'configured';
  }

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
    entries.set(entry.providerId, { ...entry, leadCount: asCount(entry.leadCount) });
  }

  for (const entry of incoming) {
    const previous = entries.get(entry.providerId);
    if (!previous) {
      entries.set(entry.providerId, { ...entry, leadCount: asCount(entry.leadCount) });
      continue;
    }

    const structured = hasStructuredCounts(previous) || hasStructuredCounts(entry);
    const counts = {
      attemptedCount: combineCount(previous, entry, 'attemptedCount'),
      observedCount: combineCount(previous, entry, 'observedCount'),
      acceptedCount: getAcceptedCount(previous) + getAcceptedCount(entry),
      reviewCount: combineCount(previous, entry, 'reviewCount'),
      deferredCount: combineCount(previous, entry, 'deferredCount'),
      completedCount: combineCount(previous, entry, 'completedCount'),
      enrichedCount: combineCount(previous, entry, 'enrichedCount'),
      blockedCount: combineCount(previous, entry, 'blockedCount'),
      timedOutCount: combineCount(previous, entry, 'timedOutCount'),
      skippedCount: combineCount(previous, entry, 'skippedCount'),
      decisionMakerRecoveredCount: combineCount(previous, entry, 'decisionMakerRecoveredCount'),
    };
    const outcome = mergeOutcome(previous, entry, counts);
    const phase = mergePhase(previous, entry, outcome);
    const merged: ProviderCoverage = {
      providerId: entry.providerId,
      providerName: entry.providerName || previous.providerName,
      status: mergeStatus(previous.status, entry.status, counts.acceptedCount, outcome, phase),
      leadCount: counts.acceptedCount,
      message: mergeMessage(previous.message, entry.message),
      ...(structured ? counts : {}),
      ...(outcome ? { outcome } : {}),
      ...(phase ? { phase } : {}),
      ...(latestTimestamp(previous.updatedAt, entry.updatedAt)
        ? { updatedAt: latestTimestamp(previous.updatedAt, entry.updatedAt) }
        : {}),
    };
    entries.set(entry.providerId, merged);
  }

  return [...entries.values()];
};

export const recordProviderCoverage = (
  progress: SearchProgress,
  entries: ProviderCoverage[],
) => {
  progress.providerCoverage = mergeProviderCoverage(progress.providerCoverage, entries);
};
