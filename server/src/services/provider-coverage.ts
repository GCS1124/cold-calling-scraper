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
  // Review and deferred work are current queue snapshots, not historical
  // events. A later durable tick must replace them (and a completed tick
  // clears them), while observations and attempts remain cumulative.
  if (field === 'deferredCount' || field === 'reviewCount') {
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
  // `deferred` is deliberately not sticky. Once a later tick reports a
  // zero remaining count, the provider has progressed and must render its
  // current returned/empty/filtered result rather than a stale queue label.
  if (counts.deferredCount > 0) return 'deferred';
  // A filtered result is an explicit current-stage decision (for example a
  // strict fusion near-match held in review). Observed candidates must not
  // turn that decision into a misleading successful retained result.
  if (incoming.outcome === 'filtered') return 'filtered';
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
  if (outcome === 'not_started') {
    return incoming.phase === 'running' ? 'running' : 'queued';
  }
  // The incoming lifecycle is the newest durable snapshot. Do not preserve a
  // previous `queued`/`running` phase after a subsequent completed tick.
  if (incoming.phase === 'running') return 'running';
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

const mergeMessage = (current: ProviderCoverage, incoming: ProviderCoverage) => {
  // Configuration and queue messages become misleading after a provider has
  // completed. Keep historical failure detail, but replace transient status
  // copy with the current completed/degraded result.
  const replacesTransientMessage =
    (current.outcome === 'not_started' || current.outcome === 'deferred') &&
    incoming.outcome !== undefined &&
    incoming.outcome !== 'not_started' &&
    incoming.outcome !== 'deferred';
  if (replacesTransientMessage) {
    return incoming.message?.trim() || current.message;
  }

  const currentMessage = current.message;
  const incomingMessage = incoming.message;
  const messages = [...new Set([currentMessage, incomingMessage].filter((value): value is string => Boolean(value?.trim())))];
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
      message: mergeMessage(previous, entry),
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
