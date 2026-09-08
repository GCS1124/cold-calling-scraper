import { AlertTriangle, ExternalLink, Mail, MapPin, Phone, ShieldCheck } from 'lucide-react';

import type { ResearchCandidate } from '../../types/lead';

type ResearchCandidatesPanelProps = {
  candidates: ResearchCandidate[];
};

const statusCopy: Record<ResearchCandidate['status'], string> = {
  needs_phone_validation: 'Grounded public reference - phone validation pending',
  needs_source_review: 'Source review required before treating this as a lead',
};

export function ResearchCandidatesPanel({ candidates }: ResearchCandidatesPanelProps) {
  if (!candidates.length) return null;

  return (
    <section
      aria-label="AI research candidates"
      className="mt-4 rounded-[1.75rem] border border-cyan-200 bg-cyan-50/70 p-4 text-slate-900 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-700">
            AI research candidates
          </p>
          <h3 className="mt-1 text-lg font-black text-cyan-950">
            {candidates.length} public candidate{candidates.length === 1 ? '' : 's'} retained
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-slate-600">
            Gemini-reported candidates and source details are preserved here even when they do not
            pass the mandatory public-phone gate. They are research references, not exportable leads,
            until an independent public source validates a phone number.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-cyan-200 bg-white px-3 py-1.5 text-xs font-bold text-cyan-900 shadow-sm">
          <ShieldCheck className="h-4 w-4" />
          Nothing silently discarded
        </span>
      </div>

      <div className="mt-4 grid max-h-[48rem] gap-3 overflow-y-auto pr-1 md:grid-cols-2">
        {candidates.map((candidate) => {
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
                  {personName ? (
                    <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-700">
                      Public person
                    </p>
                  ) : null}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] ${
                    candidate.grounded
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-amber-50 text-amber-700'
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
                      <span className="font-bold">AI-reported phone:</span> {candidate.reportedPhone}{' '}
                      <span className="text-amber-800">(unverified)</span>
                    </span>
                  </p>
                ) : null}
                {candidate.reportedEmail ? (
                  <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-2.5 py-2 text-amber-950">
                    <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-all">
                      <span className="font-bold">AI-reported email:</span> {candidate.reportedEmail}{' '}
                      <span className="text-amber-800">(unverified)</span>
                    </span>
                  </p>
                ) : null}
              {candidate.evidence ? (
                  <p>
                    <span className="font-bold text-slate-800">Evidence:</span> {candidate.evidence}
                </p>
              ) : null}
              {candidate.socialLinks?.length ? (
                <div className="flex flex-wrap gap-2">
                  {candidate.socialLinks.map((link) => (
                    <a
                      className="font-bold text-blue-700 hover:text-blue-900"
                      href={link.url}
                      key={`${candidate.id}-${link.url}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {link.platform}
                    </a>
                  ))}
                  <span className="text-slate-500">public social link(s)</span>
                </div>
              ) : null}
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-xl border border-slate-100 bg-slate-50 px-2.5 py-2 text-[11px] font-semibold leading-4 text-slate-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span>{statusCopy[candidate.status]}</span>
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
    </section>
  );
}
