import { AlertTriangle, CheckCircle2, CircleDashed, Info } from 'lucide-react';

import type { ProviderCoverage } from '../../types/lead';
import { sortProviderCoverageForDisplay } from '../../utils/source-priority';

type ProviderCoveragePanelProps = {
  coverage: ProviderCoverage[];
  mode: 'gmb' | 'ai';
};

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
      'AI mode reports the ordered public workflow: indexed NotaryCafe, pure public LinkedIn, Yelp, Yellow Pages, Gemini lead finding, Google Places, then LinkedIn + Google Business fusion. OSM and public websites remain bounded fallbacks inside the generic research slot. NotaryCafe is queried as a bounded cross-check on every AI search, but only relevant notary profiles with public phones can qualify. Commercial lead databases are audited but never called.',
    badge: 'Public-source fusion',
  },
} as const;

const getStatusLabel = (provider: ProviderCoverage) => {
  if (provider.status === 'not_configured') return 'Not configured';
  if (provider.status === 'returned') {
    return provider.providerId === 'gemini-query-assistance'
      ? 'Search lenses returned'
      : provider.providerId === 'gemini-public-discovery'
        ? `${provider.leadCount} candidates retained`
        : provider.providerId === 'gemini-listing-enrichment'
          ? `${provider.leadCount} details retained`
      : `${provider.leadCount} observed`;
  }
  if (provider.status === 'partial') {
    return /quota|rate.?limit|cooling down/i.test(provider.message ?? '')
      ? 'Quota cooling down'
      : 'Partial';
  }
  if (provider.status === 'failed') return 'Unavailable';
  if (
    provider.status === 'configured' &&
    provider.providerId === 'linkedin-public-google-business-fusion'
  ) {
    return 'Awaiting corroboration';
  }
  if (provider.providerId === 'notarycafe-indexed-search') return 'Connected';
  if (provider.providerId.endsWith('-public-directory')) return 'Connected';
  return 'Ready';
};

const getStatusClass = (status: ProviderCoverage['status']) => {
  if (status === 'returned') return 'text-emerald-700';
  if (status === 'failed' || status === 'partial') return 'text-amber-700';
  if (status === 'configured') return 'text-blue-700';
  return 'text-slate-500';
};

const StatusIcon = ({ status }: { status: ProviderCoverage['status'] }) => {
  if (status === 'returned') return <CheckCircle2 className="h-4 w-4" />;
  if (status === 'failed' || status === 'partial') {
    return <AlertTriangle className="h-4 w-4" />;
  }
  if (status === 'configured') return <CircleDashed className="h-4 w-4" />;
  return <Info className="h-4 w-4" />;
};

export function ProviderCoveragePanel({ coverage, mode }: ProviderCoveragePanelProps) {
  if (!coverage.length) return null;

  const copy = modeCopy[mode];
  const orderedCoverage = mode === 'ai' ? sortProviderCoverageForDisplay(coverage) : coverage;

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
          <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
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
              <span className="font-black">5</span> · Gemini lead finding
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
              <span className="font-black">6</span> · Google Places
            </div>
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
              <span className="font-black">7</span> · LinkedIn + Google Business fusion
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-slate-500">
            Result priority order; provider requests run in bounded independent windows. Every accepted
            row still needs a public US phone and source evidence.
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {orderedCoverage.map((provider) => (
          <div
            className="rounded-xl border border-white/80 bg-white/80 p-3"
            key={provider.providerId}
            title={provider.message}
            aria-describedby={provider.message ? `coverage-detail-${provider.providerId}` : undefined}
          >
            <p className="truncate text-sm font-bold text-slate-900">{provider.providerName}</p>
            <p
              className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold ${getStatusClass(provider.status)}`}
            >
              <StatusIcon status={provider.status} />
              {getStatusLabel(provider)}
            </p>
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
        ))}
      </div>
    </div>
  );
}
