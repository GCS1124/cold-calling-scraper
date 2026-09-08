import { AlertTriangle, CheckCircle2, CircleDashed, Info } from 'lucide-react';

import type { ProviderCoverage } from '../../types/lead';

type ProviderCoveragePanelProps = {
  coverage: ProviderCoverage[];
  mode: 'gmb' | 'linkedin' | 'ai';
};

const modeCopy = {
  gmb: {
    title: 'GMB source coverage',
    description:
      'Google Places and free public listings are reported separately. Website recovery stays bounded and only adds public contact evidence.',
    badge: 'Phone-qualified only',
  },
  linkedin: {
    title: 'LinkedIn source coverage',
    description:
      'Public profile discovery is merged with free listings and bounded website evidence. Private profiles, Premium data, and authenticated sessions are not accessed.',
    badge: 'Public profiles only',
  },
  ai: {
    title: 'Free AI mode coverage',
    description:
      'Gemini expands public search lenses and enriches Google Business listing seeds with grounded company and decision-maker details. Public evidence and the required phone gate decide which records become exportable leads. Commercial lead databases are audited but never called.',
    badge: 'No paid lead databases',
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
  if (provider.status === 'partial') return 'Partial';
  if (provider.status === 'failed') return 'Unavailable';
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

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {coverage.map((provider) => (
          <div
            className="rounded-xl border border-white/80 bg-white/80 p-3"
            key={provider.providerId}
            title={provider.message}
          >
            <p className="truncate text-sm font-bold text-slate-900">{provider.providerName}</p>
            <p
              className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold ${getStatusClass(provider.status)}`}
            >
              <StatusIcon status={provider.status} />
              {getStatusLabel(provider)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
