import { Clock3, Download, Sparkles, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../hooks/use-auth';
import { useSearchHistoryDetails } from '../hooks/use-search-history';
import { downloadLeads, defaultExportColumns } from '../utils/export';
import type { Lead } from '../types/lead';

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const buildFileName = (companyType: string, locationLabel: string | null, createdAt: string) => {
  const parts = [companyType, locationLabel ?? 'history', createdAt.slice(0, 10)]
    .map((part) =>
      part
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean);

  return parts.join('-') || 'lead-finder-history';
};

function LeadsPreviewTable({ leads }: { leads: Lead[] }) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
      <div className="overflow-x-auto">
        <table aria-label="Saved search leads" className="min-w-full text-left text-sm text-slate-700">
          <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-400">
            <tr>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Website</th>
              <th className="px-4 py-3">Source</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr className="border-t border-slate-100" key={lead.id}>
                <td className="px-4 py-4">
                  <div className="font-semibold text-slate-950">{lead.name}</div>
                  <div className="mt-1 text-xs text-slate-500">{lead.address || '—'}</div>
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
                <td className="px-4 py-4">
                  <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                    {lead.source}
                  </span>
                </td>
              </tr>
            ))}
            {!leads.length ? (
              <tr>
                <td className="px-4 py-10 text-center text-sm text-slate-500" colSpan={5}>
                  No leads were saved for this search.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function HistoryPage() {
  const auth = useAuth();
  const { items } = useSearchHistoryDetails(auth.user?.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');

  useEffect(() => {
    if (!items.length) {
      setSelectedId(null);
      return;
    }

    if (!selectedId || !items.some((item) => item.id === selectedId)) {
      setSelectedId(items[0]?.id ?? null);
    }
  }, [items, selectedId]);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );

  const selectedLeads = selectedItem?.leads ?? [];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
      <section className="rounded-[32px] border border-slate-200 bg-white/90 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-blue-700">
              <Sparkles className="h-3.5 w-3.5" />
              History
            </p>
            <h1 className="mt-5 text-[clamp(2.4rem,5vw,4rem)] font-extrabold tracking-[-0.06em] text-slate-950">
              Earlier searches, ready to reopen and download.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600 md:text-lg">
              Open a saved search to review the lead list and export the stored results again.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
              to="/search"
            >
              Go to search
            </Link>
            <Link
              className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
              to="/"
            >
              <UserRound className="h-4 w-4" />
              Account
            </Link>
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Saved searches
            </p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">{items.length}</p>
          </div>
          <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Selected search
            </p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">
              {selectedItem?.leadCount ?? 0}
            </p>
          </div>
          <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Download
            </p>
            <div className="mt-3 flex items-center gap-3">
              <select
                className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700"
                onChange={(event) => setFormat(event.target.value as 'xlsx' | 'csv')}
                value={format}
              >
                <option value="xlsx">Excel</option>
                <option value="csv">CSV</option>
              </select>
              <button
                className="inline-flex h-11 items-center gap-2 rounded-2xl bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={!selectedLeads.length}
                onClick={() => {
                  if (!selectedItem?.leads.length) {
                    return;
                  }

                  downloadLeads(selectedItem.leads, {
                    fileName: buildFileName(
                      selectedItem.companyType,
                      selectedItem.locationLabel,
                      selectedItem.createdAt,
                    ),
                    format,
                    columns: [...defaultExportColumns],
                  });
                }}
                type="button"
              >
                <Download className="h-4 w-4" />
                Download
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Search list
            </p>
            <h2 className="mt-2 text-lg font-semibold text-slate-950">Saved searches</h2>
          </div>

          <div className="space-y-3">
            {items.map((item) => {
              const active = item.id === selectedItem?.id;
              return (
                <button
                  className={[
                    'w-full rounded-[22px] border px-4 py-4 text-left transition',
                    active
                      ? 'border-blue-200 bg-blue-50/70'
                      : 'border-slate-200 bg-slate-50/70 hover:border-blue-200',
                  ].join(' ')}
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold text-slate-950">{item.companyType}</p>
                      <p className="mt-1 text-sm text-slate-600">
                        {item.locationLabel ?? item.city} · {item.count} requested
                      </p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-500">
                      {item.leadCount} leads
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                    <Clock3 className="h-3.5 w-3.5" />
                    {formatDate(item.createdAt)}
                  </div>
                </button>
              );
            })}

            {!items.length ? (
              <div className="rounded-[22px] border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
                No saved searches yet. Run a search first and come back here.
              </div>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Search details
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold text-slate-950">
                {selectedItem?.companyType ?? 'No search selected'}
              </h2>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {selectedItem?.locationLabel ?? selectedItem?.city ?? 'Select a search'}
              </span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Requested
                </p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {selectedItem?.count ?? 0}
                </p>
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Leads
                </p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {selectedItem?.leadCount ?? 0}
                </p>
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Saved
                </p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {selectedItem ? formatDate(selectedItem.createdAt) : '—'}
                </p>
              </div>
            </div>
          </div>

          <LeadsPreviewTable leads={selectedLeads} />
        </div>
      </section>
    </main>
  );
}
