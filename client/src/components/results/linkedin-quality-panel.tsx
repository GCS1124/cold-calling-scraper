import { Check, Crosshair, Globe2, Radar, ShieldCheck } from 'lucide-react';

import type { Lead } from '../../types/lead';

type LinkedInQualityPanelProps = {
  leads: Lead[];
  publicContactsFound: number;
  publicQueriesAttempted?: number;
  publicProvidersChecked?: number;
};

type SignalMeterProps = {
  label: string;
  value: number;
  detail: string;
  tone: 'blue' | 'emerald' | 'violet' | 'amber';
};

const toneClasses = {
  blue: {
    bar: 'bg-blue-600',
    value: 'text-blue-700',
  },
  emerald: {
    bar: 'bg-emerald-600',
    value: 'text-emerald-700',
  },
  violet: {
    bar: 'bg-violet-600',
    value: 'text-violet-700',
  },
  amber: {
    bar: 'bg-amber-500',
    value: 'text-amber-700',
  },
} as const;

function SignalMeter({ label, value, detail, tone }: SignalMeterProps) {
  const classes = toneClasses[tone];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white/85 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold text-slate-700">{label}</p>
        <p className={`text-sm font-black ${classes.value}`}>{value}%</p>
      </div>
      <div
        aria-label={`${label}: ${value}%`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={value}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
      >
        <div className={`h-full rounded-full ${classes.bar}`} style={{ width: `${value}%` }} />
      </div>
      <p className="mt-2 text-[11px] leading-4 text-slate-500">{detail}</p>
    </div>
  );
}

function ratioPercent(numerator: number, denominator: number) {
  if (!denominator) {
    return 0;
  }

  return Math.min(100, Math.round((numerator / denominator) * 100));
}

export function LinkedInQualityPanel({
  leads,
  publicContactsFound,
  publicQueriesAttempted,
  publicProvidersChecked,
}: LinkedInQualityPanelProps) {
  const total = leads.length;
  const averageConfidence = total
    ? Math.round(leads.reduce((sum, lead) => sum + lead.confidence, 0) / total)
    : 0;
  const highFit = leads.filter((lead) => lead.confidence >= 85).length;
  const corroborated = leads.filter((lead) => (lead.matchSignals?.publicSources ?? 0) > 1).length;
  const roleSignals = leads.filter((lead) => lead.matchSignals?.roleMatched).length;
  const evidenceBacked = leads.filter(
    (lead) => lead.publicEvidence?.profileTitle || lead.publicEvidence?.profileSnippet,
  ).length;
  const boundedContacts = Math.min(Math.max(publicContactsFound, 0), total);
  const signalDepth = ratioPercent(evidenceBacked, total);
  const corroborationDepth = ratioPercent(corroborated, total);
  const roleDepth = ratioPercent(roleSignals, total);
  const contactDepth = ratioPercent(boundedContacts, total);
  const checklist = [
    { label: 'Category', ready: leads.some((lead) => lead.matchSignals?.categoryMatched) },
    { label: 'Decision-maker', ready: roleSignals > 0 },
    { label: 'Location', ready: leads.some((lead) => lead.matchSignals?.locationMatched) },
    { label: 'Public evidence', ready: evidenceBacked > 0 },
  ];

  return (
    <div className="mt-5 rounded-[24px] border border-slate-200 bg-gradient-to-br from-white via-white to-blue-50/70 p-4 shadow-[0_18px_60px_rgba(37,99,235,0.08)] sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-950/15">
            <Radar className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-700">
              Match intelligence · LinkedIn research brief
            </p>
            <h3 className="mt-1 text-lg font-black tracking-[-0.02em] text-slate-950">
              {averageConfidence}% average public match strength
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-slate-600">
              A ranked shortlist built from public profile identity, role, category, location, and corroborating search signals.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">
          <ShieldCheck className="h-4 w-4" />
          Public signal stack
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl bg-slate-950 p-3 text-white">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">High-fit score</p>
          <p className="mt-2 text-2xl font-black">{highFit}</p>
          <p className="mt-1 text-[11px] text-slate-400">85%+ match confidence</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Cross-source</p>
          <p className="mt-2 text-2xl font-black text-slate-950">{corroborated}</p>
          <p className="mt-1 text-[11px] text-slate-500">Seen across multiple sources</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Role signals</p>
          <p className="mt-2 text-2xl font-black text-slate-950">{roleSignals}</p>
          <p className="mt-1 text-[11px] text-slate-500">Decision-maker evidence</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Public contacts</p>
          <p className="mt-2 text-2xl font-black text-slate-950">{boundedContacts}</p>
          <p className="mt-1 text-[11px] text-slate-500">Website-listed phone or email</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <SignalMeter
          detail={`${evidenceBacked} of ${total} profiles include a bounded public result excerpt.`}
          label="Evidence depth"
          tone="blue"
          value={signalDepth}
        />
        <SignalMeter
          detail={`${corroborated} of ${total} profiles have more than one public source signal.`}
          label="Corroboration"
          tone="emerald"
          value={corroborationDepth}
        />
        <SignalMeter
          detail={`${roleSignals} of ${total} profiles match an expanded decision-maker role.`}
          label="Role precision"
          tone="violet"
          value={roleDepth}
        />
        <SignalMeter
          detail={`${boundedContacts} of ${total} profiles have a publicly listed contact detail.`}
          label="Contact coverage"
          tone="amber"
          value={contactDepth}
        />
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Research checklist</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {checklist.map((item) => (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                  item.ready ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}
                key={item.label}
              >
                {item.ready ? <Check className="h-3.5 w-3.5" /> : <Crosshair className="h-3.5 w-3.5" />}
                {item.label}
              </span>
            ))}
          </div>
        </div>

        {publicQueriesAttempted || publicProvidersChecked ? (
          <div className="flex items-center gap-2 rounded-2xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <Globe2 className="h-4 w-4 text-blue-700" />
            <span>
              <strong className="font-black text-slate-900">{publicQueriesAttempted ?? 0}</strong> query paths
              <span className="mx-1 text-slate-300">/</span>
              <strong className="font-black text-slate-900">{publicProvidersChecked ?? 0}</strong> public sources
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
