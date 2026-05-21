import { ExternalLink, Copy, CheckSquare, Square } from 'lucide-react';

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

  return (
    <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
            Results
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Click any company row to verify details before export.
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
              <th className="px-4 py-3">Website</th>
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead, index) => {
              const isSelected = selectedIds.includes(lead.id);

              return (
                <tr className="border-t border-slate-100 transition hover:bg-blue-50/40" key={lead.id}>
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
                    <div className="font-semibold text-slate-950">{lead.name}</div>
                  </td>
                  <td className="px-4 py-4">{lead.mobile || '—'}</td>
                  <td className="px-4 py-4">{lead.email || '—'}</td>
                  <td className="px-4 py-4">
                    {lead.website ? (
                      <a
                        className="text-blue-700 hover:text-blue-800"
                        href={lead.website}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {lead.website.replace(/^https?:\/\//, '')}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-4 text-slate-600">{lead.address || '—'}</td>
                  <td className="px-4 py-4">
                    <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
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
                        href={lead.website || '#'}
                        onClick={(event) => {
                          if (!lead.website) event.preventDefault();
                        }}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                  </td>
                </tr>
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
