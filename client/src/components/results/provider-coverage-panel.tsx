import { AlertTriangle, CheckCircle2, CircleDashed, Info } from 'lucide-react';

import type { ProviderCoverage } from '../../types/lead';
import { sortProviderCoverageForDisplay } from '../../utils/source-priority';

type ProviderCoveragePanelProps = {
  coverage: ProviderCoverage[];
  mode: 'gmb' | 'ai';
};

// These are the user-facing stages of the locked AI workflow. Auxiliary
// diagnostics (for example deterministic Gemini lens preparation) remain
// visible below, but cannot interrupt the required result order.
const aiWorkflowProviderIds = new Set([
  'notarycafe-indexed-search',
  'linkedin-public-search',
  'yelp-public-directory',
  'yellow-pages-public-directory',
  'public-business-listings',
  'gemini-public-discovery',
  'google-places-ai',
  'public-website-enrichment',
  'linkedin-public-google-business-fusion',
]);

const modeCopy = {
  gmb: {
    title: 'GMB source coverage',
    description:
      'Google Places, free public listings, and bounded Yelp/Yellow Pages checks are reported separately. Website recovery stays bounded and only adds public contact evidence.',
    badge: 'Phone-qualified only',
  },
  ai: {
    title: 'AI mode coverage',
    description:
      'AI mode reports the ordered public workflow: indexed NotaryCafe, public LinkedIn, Yelp, Yellow Pages, generic public listings, Gemini, Google Business, public website enrichment, then final LinkedIn + Google Business fusion. Every stage is bounded and reports its real execution outcome.',
    badge: 'Public-source fusion',
  },
} as const;

const getAcceptedCount = (provider: ProviderCoverage) =>
  provider.acceptedCount ?? provider.leadCount;

const getObservedCount = (provider: ProviderCoverage) =>
  provider.observedCount ?? getAcceptedCount(provider);

const getReviewCount = (provider: ProviderCoverage) => provider.reviewCount ?? 0;

const hasStructuredMetrics = (provider: ProviderCoverage) =>
  provider.attemptedCount !== undefined ||
  provider.observedCount !== undefined ||
  provider.acceptedCount !== undefined ||
  provider.reviewCount !== undefined ||
  provider.deferredCount !== undefined ||
  provider.completedCount !== undefined ||
  provider.enrichedCount !== undefined ||
  provider.blockedCount !== undefined ||
  provider.timedOutCount !== undefined ||
  provider.skippedCount !== undefined ||
  provider.decisionMakerRecoveredCount !== undefined;

const getReturnedLabel = (provider: ProviderCoverage) => {
  const accepted = getAcceptedCount(provider);
  const observed = getObservedCount(provider);
  const review = getReviewCount(provider);

  if (provider.providerId === 'gemini-query-assistance') return 'Search lenses prepared';
  if (provider.providerId === 'gemini-listing-enrichment') {
    return `${accepted} detail${accepted === 1 ? '' : 's'} retained`;
  }
  if (provider.providerId === 'linkedin-public-google-business-fusion') {
    return review
      ? `${accepted} retained · ${review} review candidate${review === 1 ? '' : 's'}`
      : `${accepted} retained`;
  }
  if (observed !== accepted) {
    return `${observed} observed · ${accepted} accepted`;
  }
  return `${observed} observed`;
};

const getStatusLabel = (provider: ProviderCoverage) => {
  const accepted = getAcceptedCount(provider);
  const observed = getObservedCount(provider);
  const review = getReviewCount(provider);
  const suffix = accepted || review ? ` · ${accepted} accepted${review ? ` · ${review} review` : ''}` : '';

  // NotaryCafe is intentionally screened for every heading, even when the
  // heading is unrelated to notary work. Its useful zero-result state is a
  // completed category/location/phone screen—not a provider failure.
  if (
    provider.providerId === 'notarycafe-indexed-search' &&
    (provider.outcome === 'returned' || provider.outcome === 'empty' || provider.outcome === 'filtered')
  ) {
    return `${accepted} matched / ${observed} screened${review ? ` · ${review} review` : ''}`;
  }

  switch (provider.outcome) {
    case 'not_configured':
      return 'Not configured';
    case 'not_started':
      return provider.phase === 'running' ? 'Checking' : 'Queued';
    case 'returned':
      return getReturnedLabel(provider);
    case 'empty':
      return 'Checked · 0 matched';
    case 'filtered':
      return `0 retained · ${review} review candidate${review === 1 ? '' : 's'}`;
    case 'timed_out':
      return `Timed out${suffix}`;
    case 'blocked':
      return `Blocked${suffix}`;
    case 'rate_limited':
      return `Rate limited${suffix}`;
    case 'deferred':
      return `Deferred${provider.deferredCount ? ` · ${provider.deferredCount} remaining` : ''}`;
    case 'failed':
      return `Unavailable${suffix}`;
    default:
      break;
  }

  // Legacy snapshots did not carry lifecycle fields. Keep them readable while
  // all current executions use the structured outcome above.
  if (provider.status === 'not_configured') return 'Not configured';
  if (provider.status === 'returned') return getReturnedLabel(provider);
  if (provider.status === 'partial') {
    return 'Degraded';
  }
  if (provider.status === 'failed') return 'Unavailable';
  return provider.phase === 'running' ? 'Checking' : 'Queued';
};

const getStatusClass = (provider: ProviderCoverage) => {
  if (provider.outcome === 'returned' || provider.outcome === 'empty' || provider.outcome === 'filtered') {
    return 'text-emerald-700';
  }
  if (
    provider.outcome === 'failed' ||
    provider.outcome === 'timed_out' ||
    provider.outcome === 'blocked' ||
    provider.outcome === 'rate_limited' ||
    provider.status === 'failed' ||
    provider.status === 'partial'
  ) {
    return 'text-amber-700';
  }
  if (provider.outcome === 'not_started' || provider.outcome === 'deferred' || provider.status === 'configured') {
    return 'text-blue-700';
  }
  return 'text-slate-500';
};

const StatusIcon = ({ provider }: { provider: ProviderCoverage }) => {
  if (provider.outcome === 'returned' || provider.outcome === 'empty' || provider.outcome === 'filtered' || provider.status === 'returned') {
    return <CheckCircle2 className="h-4 w-4" />;
  }
  if (
    provider.outcome === 'failed' ||
    provider.outcome === 'timed_out' ||
    provider.outcome === 'blocked' ||
    provider.outcome === 'rate_limited' ||
    provider.status === 'failed' ||
    provider.status === 'partial'
  ) {
    return <AlertTriangle className="h-4 w-4" />;
  }
  if (provider.outcome === 'not_started' || provider.outcome === 'deferred' || provider.status === 'configured') {
    return <CircleDashed className="h-4 w-4" />;
  }
  return <Info className="h-4 w-4" />;
};

const getMetricSummary = (provider: ProviderCoverage) => {
  if (!hasStructuredMetrics(provider)) return null;

  const metrics = [
    provider.attemptedCount !== undefined ? `${provider.attemptedCount} attempted` : null,
    provider.observedCount !== undefined ? `${provider.observedCount} observed` : null,
    provider.acceptedCount !== undefined ? `${provider.acceptedCount} accepted` : null,
    provider.reviewCount ? `${provider.reviewCount} review` : null,
    provider.deferredCount ? `${provider.deferredCount} deferred` : null,
    provider.completedCount !== undefined ? `${provider.completedCount} completed` : null,
    provider.enrichedCount ? `${provider.enrichedCount} enriched` : null,
    provider.blockedCount ? `${provider.blockedCount} blocked` : null,
    provider.timedOutCount ? `${provider.timedOutCount} timed out` : null,
    provider.skippedCount ? `${provider.skippedCount} skipped` : null,
    provider.decisionMakerRecoveredCount
      ? `${provider.decisionMakerRecoveredCount} decision-maker recovered`
      : null,
  ].filter((value): value is string => Boolean(value));

  return metrics.length ? metrics.join(' · ') : null;
};

export function ProviderCoveragePanel({ coverage, mode }: ProviderCoveragePanelProps) {
  if (!coverage.length) return null;

  const copy = modeCopy[mode];
  const orderedCoverage = mode === 'ai' ? sortProviderCoverageForDisplay(coverage) : coverage;
  const workflowCoverage = mode === 'ai'
    ? orderedCoverage.filter((provider) => aiWorkflowProviderIds.has(provider.providerId))
    : orderedCoverage;
  const supplementalCoverage = mode === 'ai'
    ? orderedCoverage.filter((provider) => !aiWorkflowProviderIds.has(provider.providerId))
    : [];

  const renderProviderCard = (provider: ProviderCoverage) => (
    <div
      className="rounded-xl border border-white/80 bg-white/80 p-3"
      data-provider-id={provider.providerId}
      key={provider.providerId}
      title={provider.message}
      aria-describedby={provider.message ? `coverage-detail-${provider.providerId}` : undefined}
    >
      <p className="truncate text-sm font-bold text-slate-900">{provider.providerName}</p>
      <p
        className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold ${getStatusClass(provider)}`}
      >
        <StatusIcon provider={provider} />
        {getStatusLabel(provider)}
      </p>
      {getMetricSummary(provider) ? (
        <p className="mt-1 text-[10px] font-medium leading-4 text-slate-500">
          {getMetricSummary(provider)}
        </p>
      ) : null}
      {provider.message ? (
        <p
          className="mt-2 max-h-12 overflow-hidden text-[11px] leading-4 text-slate-500"
          id={`coverage-detail-${provider.providerId}`}
          title={provider.message}
        >
          {provider.message}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
            {copy.title}
          </p>
          <p className="mt-1 text-sm leading-5 text-slate-600">{copy.description}</p>
        </div>
        <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-blue-700 shadow-sm">
          {copy.badge}
        </span>
      </div>

      {mode === 'ai' ? (
        <div
          aria-label="Required AI result priority"
          className="mt-4 rounded-xl border border-blue-200 bg-white/75 p-3"
        >
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-700">
            Required AI result priority
          </p>
          <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg bg-blue-50 px-3 py-2 text-blue-950">
              <span className="font-black">1</span> · NotaryCafe indexed profile
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
              <span className="font-black">2</span> · Pure public LinkedIn evidence
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
              <span className="font-black">3</span> · Yelp public directory
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
              <span className="font-black">4</span> · Yellow Pages public directory
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
              <span className="font-black">5</span> · Generic public listings
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
              <span className="font-black">6</span> · Gemini public research
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
              <span className="font-black">7</span> · Google Business listings
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
              <span className="font-black">8</span> · Public website enrichment
            </div>
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
              <span className="font-black">9</span> · Final LinkedIn + Google Business fusion
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-slate-500">
            Result priority order; provider requests run in bounded independent windows. Every accepted
            row still needs a public US phone and source evidence.
          </p>
        </div>
      ) : null}

      <div
        aria-label={mode === 'ai' ? 'AI workflow provider status' : 'Provider status'}
        className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {workflowCoverage.map(renderProviderCard)}
      </div>
      {supplementalCoverage.length ? (
        <details className="mt-3 rounded-xl border border-blue-100 bg-white/60 p-3">
          <summary className="cursor-pointer text-xs font-bold text-slate-700">
            Supplemental provider diagnostics ({supplementalCoverage.length})
          </summary>
          <div aria-label="Supplemental provider diagnostics" className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {supplementalCoverage.map(renderProviderCard)}
          </div>
        </details>
      ) : null}
    </div>
  );
}
