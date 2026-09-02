import { ExternalLink, Copy, CheckSquare, Square } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import { Fragment, useState } from 'react';

import type { Lead } from '../../types/lead';

type ResultsTableProps = {
  leads: Lead[];
  emptyStateMessage?: string;
  selectedIds: string[];
  onToggleSelect: (leadId: string) => void;
  onSelectAll: () => void;
  onCopyRow: (lead: Lead) => void;
};

export function ResultsTable({
  leads,
  emptyStateMessage = 'No leads match the current filters.',
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onCopyRow,
}: ResultsTableProps) {
  const allSelected = leads.length > 0 && leads.every((lead) => selectedIds.includes(lead.id));
  const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null);

  return (
    <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
            Results
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Open a company name to inspect details before export.
          </p>
        </div>

        <button
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-blue-200 hover:text-blue-700"
          onClick={onSelectAll}
          type="button"
        >
          {allSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
          {allSelected ? 'Clear visible' : 'Select visible'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table aria-label="Lead results" className="min-w-full text-left text-sm text-slate-700">
          <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-400">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Website / Profile</th>
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead, index) => {
              const isSelected = selectedIds.includes(lead.id);
              const isPublicLinkedInLead = lead.source.toLowerCase().includes('linkedin');
              const isExpanded = expandedLeadId === lead.id;
              const matchLabel =
                lead.confidence >= 85
                  ? 'Strong match'
                  : lead.confidence >= 70
                    ? 'Good match'
                    : 'Potential match';

              return (
                <Fragment key={lead.id}>
                  <tr className="border-t border-slate-100 transition hover:bg-blue-50/40">
                    <td className="px-4 py-4">
                      <button
                        aria-label={`Select ${lead.name}`}
                        className="text-blue-700"
                        onClick={() => onToggleSelect(lead.id)}
                        type="button"
                      >
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                      <span className="ml-3 text-xs text-slate-400">{index + 1}</span>
                    </td>
                    <td className="px-4 py-4">
                      <button
                        aria-controls={`lead-details-${lead.id}`}
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Hide' : 'Inspect'} ${lead.name}`}
                        className="inline-flex max-w-full items-center gap-2 text-left font-semibold text-slate-950 transition hover:text-blue-700"
                        onClick={() => setExpandedLeadId(isExpanded ? null : lead.id)}
                        type="button"
                      >
                        <span className="truncate">{lead.name}</span>
                        <ChevronDown
                          className={`h-4 w-4 shrink-0 text-slate-400 transition ${isExpanded ? 'rotate-180' : ''}`}
                        />
                      </button>
                      {lead.headline ? (
                        <div
                          className="mt-1 max-w-[280px] truncate text-xs font-medium text-slate-500"
                          title={lead.headline}
                        >
                          {lead.headline}
                        </div>
                      ) : null}
                      {isPublicLinkedInLead ? (
                        <>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
                            <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700">
                              Public match
                            </span>
                            <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                              {matchLabel} · {lead.confidence}%
                            </span>
                            {lead.matchSignals?.publicSources && lead.matchSignals.publicSources > 1 ? (
                              <span
                                className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-700"
                                title={`${lead.matchSignals.queryMatches} public query matches across ${lead.matchSignals.publicProviderNames?.join(', ') || `${lead.matchSignals.publicSources} public sources`}`}
                              >
                                {lead.matchSignals.publicSources}-source signal
                              </span>
                            ) : null}
                          </div>
                          {lead.matchSignals ? (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                              {lead.matchSignals.roleMatched ? (
                                <span
                                  className="rounded-full border border-violet-100 bg-violet-50 px-2 py-1 text-violet-700"
                                  title="The public profile matched an expanded decision-maker role term."
                                >
                                  Role signal
                                </span>
                              ) : null}
                              {lead.matchSignals.locationMatched ? (
                                <span
                                  className="rounded-full border border-amber-100 bg-amber-50 px-2 py-1 text-amber-700"
                                  title="The public result contained a matching city, state, or regional signal."
                                >
                                  Location signal
                                </span>
                              ) : null}
                              {lead.matchSignals.queryMatches > 0 ? (
                                <span
                                  className="rounded-full border border-slate-200 bg-white px-2 py-1 text-slate-600"
                                  title="Number of public query paths that matched this lead."
                                >
                                  {lead.matchSignals.queryMatches} query paths
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </td>
                    <td className="px-4 py-4">{lead.mobile || '—'}</td>
                    <td className="px-4 py-4">{lead.email || '—'}</td>
                    <td className="px-4 py-4">
                      {lead.website || lead.listingUrl ? (
                        <a
                          className="text-blue-700 hover:text-blue-800"
                          href={lead.website || lead.listingUrl || '#'}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {(lead.website || lead.listingUrl || '').replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      <span className="block max-w-[220px] truncate" title={lead.address || undefined}>
                        {lead.address || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-semibold ${
                          isPublicLinkedInLead
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        {lead.source}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2">
                        <button
                          className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-blue-200 hover:text-blue-700"
                          onClick={() => onCopyRow(lead)}
                          type="button"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                        <a
                          className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-blue-200 hover:text-blue-700"
                          href={lead.website || lead.listingUrl || '#'}
                          onClick={(event) => {
                            if (!lead.website && !lead.listingUrl) event.preventDefault();
                          }}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr className="border-t border-slate-100 bg-slate-50/70" id={`lead-details-${lead.id}`}>
                      <td className="px-4 py-5" colSpan={8}>
                        <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                              Lead snapshot
                            </p>
                            <p className="mt-2 text-sm leading-5 text-slate-600">
                              {isPublicLinkedInLead
                                ? 'Profile identity is public; contact fields are kept only when openly listed on a business website.'
                                : 'Review the available business details before adding this lead to your export.'}
                            </p>
                            {lead.contactSourceUrl ? (
                              <p className="mt-3 text-xs leading-5 text-slate-500">
                                Public contact source:{' '}
                                <a
                                  className="font-semibold text-blue-700 hover:text-blue-800"
                                  href={lead.contactSourceUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  {lead.contactSourceUrl.replace(/^https?:\/\//, '')}
                                </a>
                              </p>
                            ) : null}
                            {isPublicLinkedInLead &&
                            (lead.publicEvidence?.profileTitle || lead.publicEvidence?.profileSnippet) ? (
                              <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/60 p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">
                                  Public match excerpt
                                </p>
                                {lead.publicEvidence.profileTitle ? (
                                  <p className="mt-2 text-xs font-semibold leading-5 text-slate-800">
                                    {lead.publicEvidence.profileTitle}
                                  </p>
                                ) : null}
                                {lead.publicEvidence.profileSnippet ? (
                                  <p className="mt-1 text-xs leading-5 text-slate-600">
                                    {lead.publicEvidence.profileSnippet}
                                  </p>
                                ) : null}
                                <p className="mt-2 text-[11px] leading-4 text-slate-500">
                                  Excerpt from a public search result. Verify the linked profile before outreach.
                                </p>
                                {lead.publicEvidence.sources?.length ? (
                                  <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-blue-700">
                                      {lead.publicEvidence.sources.length} public result{' '}
                                      {lead.publicEvidence.sources.length === 1 ? 'trace' : 'traces'}
                                    </span>
                                    {lead.publicEvidence.sources.map((source, index) => (
                                      <span
                                        className="rounded-full border border-blue-100 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600"
                                        key={source.providerName + '-' + index}
                                      >
                                        {source.providerName}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                            <div className="mt-4 grid gap-2 sm:grid-cols-3">
                              <div className="rounded-xl border border-slate-200 bg-white p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                                  Email
                                </p>
                                <p className="mt-1 truncate text-sm font-semibold text-slate-900">
                                  {lead.email || 'Not listed'}
                                </p>
                              </div>
                              <div className="rounded-xl border border-slate-200 bg-white p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                                  Phone
                                </p>
                                <p className="mt-1 text-sm font-semibold text-slate-900">
                                  {lead.mobile || 'Not listed'}
                                </p>
                              </div>
                              <div className="rounded-xl border border-slate-200 bg-white p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                                  Website
                                </p>
                                <p className="mt-1 truncate text-sm font-semibold text-slate-900">
                                  {lead.website ? 'Available' : 'Not listed'}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                              Match evidence
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                              <span className="rounded-full bg-white px-3 py-2 text-slate-700">
                                Confidence {lead.confidence}%
                              </span>
                              {isPublicLinkedInLead && lead.matchSignals ? (
                                <>
                                  {lead.matchSignals.categoryMatched ? (
                                    <span className="rounded-full bg-blue-50 px-3 py-2 text-blue-700">
                                      Category matched
                                    </span>
                                  ) : null}
                                  <span className="rounded-full bg-violet-50 px-3 py-2 text-violet-700">
                                    {lead.matchSignals.roleMatched ? 'Role matched' : 'Role not confirmed'}
                                  </span>
                                  <span className="rounded-full bg-amber-50 px-3 py-2 text-amber-700">
                                    {lead.matchSignals.locationMatched ? 'Location matched' : 'Location not confirmed'}
                                  </span>
                                  <span className="rounded-full bg-emerald-50 px-3 py-2 text-emerald-700">
                                    {lead.matchSignals.queryMatches} query paths · {lead.matchSignals.publicSources} public sources
                                  </span>
                                  <span className="rounded-full bg-blue-50 px-3 py-2 text-blue-700">
                                    {lead.matchSignals.publicProviderNames?.join(' + ') || 'Public search sources'}
                                  </span>
                                </>
                              ) : null}
                            </div>
                            <p className="mt-4 text-xs leading-5 text-slate-500">
                              Source: {lead.source}. Verify the linked website or public profile before outreach.
                            </p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {!leads.length ? (
              <tr>
                <td className="px-4 py-10 text-center text-sm text-slate-500" colSpan={8}>
                  {emptyStateMessage}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
