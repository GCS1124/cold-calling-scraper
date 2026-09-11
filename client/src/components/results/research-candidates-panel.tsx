import { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, Mail, MapPin, Phone, ShieldCheck } from 'lucide-react';

import type { ResearchCandidate, ReviewCandidate, ReviewCandidateReason } from '../../types/lead';

type ResearchCandidatesPanelProps = {
  candidates?: ResearchCandidate[];
  reviewCandidates?: ReviewCandidate[];
};

type QueueCandidate = ReviewCandidate & {
  grounded?: boolean;
};

const reasonCopy: Record<ReviewCandidateReason, string> = {
  missing_public_phone: 'A public phone is still required before export.',
  invalid_public_phone: 'The reported public phone did not pass US-phone validation.',
  missing_source_evidence: 'Public source evidence needs an independent review.',
  category_mismatch: 'The public profile did not explicitly match the requested category.',
  location_mismatch: 'The public profile did not deterministically match the requested location.',
  organization_unmatched: 'No strict organization and location match was found for fusion.',
  organization_ambiguous: 'More than one organization match remained plausible, so none was fused.',
  former_or_conflicting: 'Public employment evidence was former or conflicted with the business record.',
  website_timeout: 'The public business website did not finish in the bounded enrichment window.',
  website_blocked: 'The public website denied this bounded check; no access control was bypassed.',
  provider_timeout: 'This provider did not finish in its bounded execution window.',
  provider_blocked: 'This provider presented an access challenge; it was not bypassed.',
  provider_rate_limited: 'This provider rate-limited the bounded request.',
  deferred_by_budget: 'This public candidate is queued for a later durable search tick.',
};

const reasonLabel = (reason: ReviewCandidateReason) => reason.replace(/_/g, ' ');

const toQueueCandidate = (candidate: ResearchCandidate): QueueCandidate => ({
  // Match the server-side ReviewCandidate id so an additive legacy
  // researchCandidates payload cannot render the same Gemini reference twice.
  id: `gemini-public-discovery-review-${candidate.id}`,
  providerId: 'gemini-public-discovery',
  providerName: 'Gemini public discovery',
  reason:
    candidate.status === 'needs_phone_validation'
      ? 'missing_public_phone'
      : 'missing_source_evidence',
  name: candidate.name,
  personName: candidate.personName,
  organizationName: candidate.organizationName,
  originalRole: candidate.originalRole,
  location: candidate.location,
  website: candidate.website,
  profileUrl: candidate.socialLinks?.[0]?.url,
  reportedPhone: candidate.reportedPhone,
  reportedEmail: candidate.reportedEmail,
  sourceUrls: candidate.sourceUrls,
  sourceTitles: candidate.sourceTitles,
  evidence: candidate.evidence,
  discoveredAt: candidate.discoveredAt,
  grounded: candidate.grounded,
});

export function ResearchCandidatesPanel({
  candidates = [],
  reviewCandidates = [],
}: ResearchCandidatesPanelProps) {
  const queue = useMemo(() => {
    const deduped = new Map<string, QueueCandidate>();

    for (const candidate of reviewCandidates) {
      deduped.set(candidate.id, candidate);
    }
    for (const candidate of candidates) {
      const normalized = toQueueCandidate(candidate);
      if (!deduped.has(normalized.id)) deduped.set(normalized.id, normalized);
    }

    return [...deduped.values()].sort((left, right) =>
      right.discoveredAt.localeCompare(left.discoveredAt),
    );
  }, [candidates, reviewCandidates]);
  const [providerFilter, setProviderFilter] = useState('all');
  const [reasonFilter, setReasonFilter] = useState<'all' | ReviewCandidateReason>('all');

  const providers = useMemo(
    () => [...new Map(queue.map((candidate) => [candidate.providerId, candidate.providerName])).entries()],
    [queue],
  );
  const visibleCandidates = useMemo(
    () =>
      queue.filter(
        (candidate) =>
          (providerFilter === 'all' || candidate.providerId === providerFilter) &&
          (reasonFilter === 'all' || candidate.reason === reasonFilter),
      ),
    [providerFilter, queue, reasonFilter],
  );

  if (!queue.length) return null;

  return (
    <section
      aria-label="Unified review queue"
      className="mt-4 rounded-[1.75rem] border border-cyan-200 bg-cyan-50/70 p-4 text-slate-900 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">
            Unified public review queue
          </p>
          <h3 className="mt-1 text-lg font-black text-cyan-950">
            {queue.length} candidate{queue.length === 1 ? '' : 's'} retained for review
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-slate-600">
            Useful public evidence stays visible here when it fails a category, location, phone,
            provider, website, or fusion gate. Nothing in this queue is included in CSV or XLSX
            export until it independently passes the normal public-phone and evidence checks.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-cyan-200 bg-white px-3 py-1.5 text-xs font-bold text-cyan-900 shadow-sm">
          <ShieldCheck className="h-4 w-4" />
          Export gate enforced
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <label className="text-xs font-bold text-slate-700">
          Provider
          <select
            aria-label="Filter review queue by provider"
            className="mt-1 block w-full rounded-xl border border-cyan-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500"
            onChange={(event) => setProviderFilter(event.target.value)}
            value={providerFilter}
          >
            <option value="all">All providers</option>
            {providers.map(([providerId, providerName]) => (
              <option key={providerId} value={providerId}>
                {providerName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-bold text-slate-700">
          Reason
          <select
            aria-label="Filter review queue by reason"
            className="mt-1 block w-full rounded-xl border border-cyan-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 outline-none transition focus:border-cyan-500"
            onChange={(event) => setReasonFilter(event.target.value as 'all' | ReviewCandidateReason)}
            value={reasonFilter}
          >
            <option value="all">All reasons</option>
            {[...new Set(queue.map((candidate) => candidate.reason))].map((reason) => (
              <option key={reason} value={reason}>
                {reasonLabel(reason)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {visibleCandidates.length ? (
        <div className="mt-4 grid max-h-[48rem] gap-3 overflow-y-auto pr-1 md:grid-cols-2">
          {visibleCandidates.map((candidate) => {
            const personName = candidate.personName || (
              candidate.organizationName && candidate.name !== candidate.organizationName
                ? candidate.name
                : ''
            );
            const displayName = personName || candidate.organizationName || candidate.name || 'Unnamed candidate';

            return (
              <article
                className="rounded-2xl border border-cyan-100 bg-white/90 p-4 shadow-sm"
                key={candidate.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-black text-slate-950">{displayName}</h4>
                    {candidate.organizationName && personName ? (
                      <p className="mt-1 truncate text-sm font-semibold text-slate-600">
                        {candidate.organizationName}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-cyan-700">
                      {candidate.providerName}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] ${
                      candidate.grounded ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {candidate.grounded ? 'Grounded' : 'Review'}
                  </span>
                </div>

                <div className="mt-3 space-y-2 text-xs leading-5 text-slate-600">
                  {candidate.originalRole ? (
                    <p>
                      <span className="font-bold text-slate-800">Role:</span> {candidate.originalRole}
                    </p>
                  ) : null}
                  {candidate.location ? (
                    <p className="flex items-start gap-2">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-700" />
                      <span>{candidate.location}</span>
                    </p>
                  ) : null}
                  {candidate.reportedPhone ? (
                    <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-2.5 py-2 text-amber-950">
                      <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        <span className="font-bold">Publicly reported phone:</span> {candidate.reportedPhone}{' '}
                        <span className="text-amber-800">(unverified)</span>
                      </span>
                    </p>
                  ) : null}
                  {candidate.reportedEmail ? (
                    <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-2.5 py-2 text-amber-950">
                      <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="break-all">
                        <span className="font-bold">Publicly reported email:</span> {candidate.reportedEmail}{' '}
                        <span className="text-amber-800">(unverified)</span>
                      </span>
                    </p>
                  ) : null}
                  {candidate.evidence ? (
                    <p>
                      <span className="font-bold text-slate-800">Evidence:</span> {candidate.evidence}
                    </p>
                  ) : null}
                </div>

                <div className="mt-3 flex items-start gap-2 rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-2 text-[11px] font-semibold leading-4 text-slate-600">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>
                    <span className="capitalize">{reasonLabel(candidate.reason)}.</span>{' '}
                    {candidate.reasonDetail || reasonCopy[candidate.reason]}
                  </span>
                </div>

                {candidate.sourceUrls.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {candidate.sourceUrls.map((sourceUrl, index) => (
                      <a
                        className="inline-flex max-w-full items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-blue-700 transition hover:border-blue-300 hover:bg-blue-50"
                        href={sourceUrl}
                        key={`${candidate.id}-${sourceUrl}`}
                        rel="noreferrer"
                        target="_blank"
                        title={sourceUrl}
                      >
                        <ExternalLink className="h-3 w-3 shrink-0" />
                        <span className="max-w-[13rem] truncate">
                          {candidate.sourceTitles?.[index] || `Public source ${index + 1}`}
                        </span>
                      </a>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed border-cyan-200 bg-white/70 px-3 py-4 text-sm text-slate-600">
          No review candidates match these filters.
        </p>
      )}
    </section>
  );
}
