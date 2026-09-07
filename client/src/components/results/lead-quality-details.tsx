import type { Lead } from '../../types/lead';
import { qualityLabels, type QualityFilter } from '../../utils/lead-quality';

export function LeadQualityBadge({ lead }: { lead: Lead }) {
  const tier = lead.quality?.tier ?? 'review';
  return (
    <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${
      tier === 'corroborated' ? 'bg-emerald-50 text-emerald-800'
        : tier === 'supported' ? 'bg-blue-50 text-blue-800' : 'bg-amber-50 text-amber-800'
    }`}>
      {qualityLabels[tier]}
    </span>
  );
}

export function LeadQualityDetails({ lead }: { lead: Lead }) {
  const quality = lead.quality;
  if (!quality) return <p className="mb-4 text-sm text-amber-800">Legacy result: contact evidence needs a fresh check.</p>;
  const website = lead.websiteAssessment;
  const websiteLabel = website?.status === 'confirmed'
    ? 'Identity confirmed'
    : website?.status === 'probable'
      ? 'Identity probable'
      : website?.status === 'parked'
        ? 'Parked domain'
        : website?.status === 'blocked'
          ? 'Crawl blocked'
          : website?.status === 'unrelated'
            ? 'Identity not matched'
            : 'Unavailable';
  return (
    <section aria-label={`Contact evidence for ${lead.name}`} className="mb-5 rounded-2xl border border-blue-100 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-950">Contact evidence</h3>
          <LeadQualityBadge lead={lead} />
        </div>
        <p className="text-xs text-slate-500" title="A rule-based ranking score, not an accuracy probability.">
          Evidence score <strong className="text-slate-900">{quality.score}/100</strong>
        </p>
      </div>
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-4">
        <div><dt className="text-slate-500">Phone association</dt><dd className="mt-1 font-semibold text-slate-900">{quality.phone.association === 'business' ? 'Business contact route' : quality.phone.association === 'person' ? 'Person-associated source' : 'Unconfirmed'}</dd></div>
        <div><dt className="text-slate-500">Last phone observation</dt><dd className="mt-1 font-semibold text-slate-900">{quality.lastObservedAt ? new Date(quality.lastObservedAt).toLocaleDateString() : 'Unknown'}{quality.freshness === 'stale' ? ' (needs refresh)' : ''}</dd></div>
        <div><dt className="text-slate-500">Independent source families</dt><dd className="mt-1 font-semibold text-slate-900">{quality.independentSourceCount ?? 'Unknown'}{quality.sourceFamilies?.length ? ` · ${quality.sourceFamilies.join(', ')}` : ''}</dd></div>
        <div><dt className="text-slate-500">Checks still needed</dt><dd className="mt-1 font-semibold text-slate-900">Line type, reachability, email delivery</dd></div>
      </dl>
      {website && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="text-xs font-bold text-slate-900">Website identity</h4>
              <p className="mt-1 text-xs text-slate-600">{websiteLabel} <span className="text-slate-400">({website.score}/100 rule score)</span></p>
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">robots: {website.robots}</span>
          </div>
          <p className="mt-2 break-all text-[11px] text-slate-500">{website.canonicalHost || 'Unknown host'} · observed {new Date(website.observedAt).toLocaleDateString()}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ul className="space-y-1 text-xs leading-5 text-slate-600">
              {website.reasons.map((reason) => <li key={`website-reason-${reason}`}>{reason}</li>)}
            </ul>
            <ul className="space-y-1 text-xs leading-5 text-slate-600">
              {website.gaps.map((gap) => <li key={`website-gap-${gap}`}>{gap}</li>)}
            </ul>
          </div>
          <a className="mt-3 inline-block text-xs font-semibold text-blue-700 underline underline-offset-2" href={website.sourceUrl} rel="noreferrer" target="_blank">Open assessed page</a>
        </div>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div><h4 className="text-xs font-bold text-emerald-800">Supporting evidence</h4><ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600">{quality.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>
        <div><h4 className="text-xs font-bold text-amber-800">Review before outreach</h4><ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600">{quality.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></div>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {quality.phone.sourceUrls.map((url, index) => <a className="font-semibold text-blue-700 underline underline-offset-2" href={url} key={url} rel="noreferrer" target="_blank">Phone source {index + 1}</a>)}
        {quality.email.sourceUrls.map((url, index) => <a className="font-semibold text-blue-700 underline underline-offset-2" href={url} key={url} rel="noreferrer" target="_blank">Email source {index + 1}</a>)}
      </div>
      <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-700"><strong>Next step:</strong> {quality.nextAction}</p>
    </section>
  );
}

export function LeadQualityPanel({ leads, value, onChange }: { leads: Lead[]; value: QualityFilter; onChange: (value: QualityFilter) => void }) {
  return (
    <section aria-label="Lead quality filters" className="mb-4 rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-blue-50/50 p-4">
      <h3 className="text-sm font-bold text-slate-950">Prioritize by contact evidence</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">Every result requires a public phone. Phone corroboration is not proof of a personal mobile or a reachable line.</p>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {(['all', 'corroborated', 'supported', 'review'] as const).map((tier) => {
          const count = leads.filter((lead) => tier === 'all' || (lead.quality?.tier ?? 'review') === tier).length;
          const label = tier === 'all' ? 'All public-phone leads' : qualityLabels[tier];
          return (
            <button
              aria-label={`${label} ${count}`}
              aria-pressed={value === tier}
              className={`rounded-xl border px-3 py-3 text-left transition ${value === tier ? 'border-blue-600 bg-white shadow-sm' : 'border-transparent bg-white/60 hover:border-slate-300'}`}
              key={tier}
              onClick={() => onChange(tier)}
              type="button"
            >
              <span className="block text-[11px] font-semibold text-slate-600">{label}</span>
              <strong className="mt-1 block text-lg text-slate-950">{count}</strong>
            </button>
          );
        })}
      </div>
    </section>
  );
}
