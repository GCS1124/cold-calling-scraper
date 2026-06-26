import {
  ArrowRight,
  CalendarClock,
  Clock3,
  Download,
  ExternalLink,
  FileSpreadsheet,
  MapPin,
  Search,
  Sparkles,
  TableProperties,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { SessionAction } from '../components/auth/session-action';
import { useAuth } from '../hooks/use-auth';
import { useSearchHistoryDetails } from '../hooks/use-search-history';
import { downloadLeads, defaultExportColumns } from '../utils/export';
import type { Lead } from '../types/lead';

const formatDate = (value?: string | null) => {
  if (!value) return '—';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const buildFileName = (
  companyType: string,
  locationLabel: string | null,
  createdAt: string,
) => {
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

const getWebsiteHref = (website: string) =>
  /^https?:\/\//i.test(website) ? website : `https://${website}`;

const getWebsiteLabel = (website: string) =>
  website.replace(/^https?:\/\//i, '').replace(/\/$/, '');

function LeadsPreviewTable({ leads }: { leads: Lead[] }) {
  return (
    <div className="overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white/95 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
      <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
            <TableProperties className="h-3.5 w-3.5" />
            Lead preview
          </p>
          <h2 className="mt-2 text-xl font-black tracking-[-0.035em] text-slate-950">
            Saved lead list
          </h2>
        </div>

        <span className="w-fit rounded-2xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700">
          {leads.length} {leads.length === 1 ? 'lead' : 'leads'}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table
          aria-label="Saved search leads"
          className="min-w-full text-left text-sm text-slate-700"
        >
          <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-400">
            <tr>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Company</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Phone</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Email</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Website</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Source</th>
            </tr>
          </thead>

          <tbody>
            {leads.map((lead) => (
              <tr
                className="border-t border-slate-100 transition hover:bg-slate-50/80"
                key={lead.id}
              >
                <td className="min-w-[240px] px-5 py-4">
                  <div className="font-bold text-slate-950">{lead.name}</div>
                  <div className="mt-1 max-w-sm text-xs leading-5 text-slate-500">
                    {lead.address || 'No address saved'}
                  </div>
                </td>

                <td className="whitespace-nowrap px-5 py-4 font-medium text-slate-700">
                  {lead.mobile || '—'}
                </td>

                <td className="whitespace-nowrap px-5 py-4">
                  {lead.email ? (
                    <a
                      className="font-medium text-blue-700 hover:text-blue-800"
                      href={`mailto:${lead.email}`}
                    >
                      {lead.email}
                    </a>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>

                <td className="min-w-[180px] px-5 py-4">
                  {lead.website ? (
                    <a
                      className="inline-flex items-center gap-1.5 font-medium text-blue-700 hover:text-blue-800"
                      href={getWebsiteHref(lead.website)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <span>{getWebsiteLabel(lead.website)}</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>

                <td className="whitespace-nowrap px-5 py-4">
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
                    {lead.source}
                  </span>
                </td>
              </tr>
            ))}

            {!leads.length ? (
              <tr>
                <td className="px-5 py-16 text-center" colSpan={5}>
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
                    <Search className="h-7 w-7" />
                  </div>

                  <h3 className="mt-5 text-lg font-black tracking-[-0.03em] text-slate-950">
                    No leads saved
                  </h3>

                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">
                    This saved search does not contain stored leads.
                  </p>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HistoryStatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[1.5rem] border border-slate-200 bg-white/90 p-5 shadow-[0_18px_60px_rgba(15,23,42,0.08)] backdrop-blur">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">{label}</p>
      <p className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">{value}</p>
    </div>
  );
}

export function HistoryPage() {
  const auth = useAuth();
  const { items } = useSearchHistoryDetails(auth.user?.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');

  const sortedItems = useMemo(() => {
    return [...items].sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    );
  }, [items]);

  useEffect(() => {
    if (!sortedItems.length) {
      setSelectedId(null);
      return;
    }

    if (!selectedId || !sortedItems.some((item) => item.id === selectedId)) {
      setSelectedId(sortedItems[0]?.id ?? null);
    }
  }, [sortedItems, selectedId]);

  const selectedItem = useMemo(
    () => sortedItems.find((item) => item.id === selectedId) ?? sortedItems[0] ?? null,
    [sortedItems, selectedId],
  );

  const selectedLeads = useMemo(() => selectedItem?.leads ?? [], [selectedItem]);

  const totalLeadCount = useMemo(
    () =>
      sortedItems.reduce(
        (total, item) => total + (item.leadCount ?? item.leads?.length ?? 0),
        0,
      ),
    [sortedItems],
  );

  const selectedLeadStats = useMemo(
    () => ({
      withEmail: selectedLeads.filter((lead) => lead.hasEmail || Boolean(lead.email)).length,
      withPhone: selectedLeads.filter((lead) => lead.hasPhone || Boolean(lead.mobile)).length,
      withWebsite: selectedLeads.filter((lead) => lead.hasWebsite || Boolean(lead.website))
        .length,
    }),
    [selectedLeads],
  );

  const handleDownload = () => {
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
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-50 text-slate-950">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 top-[-10rem] h-96 w-96 rounded-full bg-blue-200/60 blur-3xl" />
        <div className="absolute right-[-8rem] top-20 h-96 w-96 rounded-full bg-cyan-200/60 blur-3xl" />
        <div className="absolute bottom-[-14rem] left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-indigo-100 blur-3xl" />
      </div>

      <header className="relative mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-5 md:px-8">
        <Link
          className="inline-flex items-center gap-3 text-sm font-black tracking-tight text-slate-950"
          to="/search"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-900/15">
            <Sparkles className="h-4 w-4" />
          </span>
          Lead Finder Pro
        </Link>

        <nav className="flex items-center gap-2">
          <Link
            className="inline-flex h-10 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 text-sm font-semibold text-slate-700 shadow-sm backdrop-blur transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
            to="/search"
          >
            <ArrowRight className="h-4 w-4" />
            <span className="hidden sm:inline">Search</span>
          </Link>

          <SessionAction auth={auth} />
        </nav>
      </header>

      <section className="relative mx-auto grid max-w-7xl gap-6 px-4 pb-6 pt-3 md:px-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="overflow-hidden rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-[0_30px_100px_rgba(15,23,42,0.10)] backdrop-blur md:p-8 lg:p-10">
          <div className="flex items-start justify-between gap-6">
            <div className="max-w-3xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-4 py-2 text-xs font-bold uppercase tracking-[0.22em] text-blue-700">
                <Clock3 className="h-3.5 w-3.5" />
                Search history
              </p>

              <h1 className="mt-6 max-w-3xl text-4xl font-black leading-[0.95] tracking-[-0.06em] text-slate-950 sm:text-5xl xl:text-6xl">
                Reopen, review, and export past searches.
              </h1>

              <p className="mt-5 max-w-2xl text-base leading-7 text-slate-500 md:text-lg">
                Every saved search stays organized with its location, requested count, saved leads,
                and export-ready lead data.
              </p>
            </div>

            <div className="hidden shrink-0 rounded-[1.5rem] bg-slate-50 p-4 text-blue-700 lg:flex">
              <Sparkles className="h-6 w-6" />
            </div>
          </div>
        </div>

        <div className="grid gap-4">
          <div className="rounded-[2rem] border border-white/70 bg-white/90 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.10)] backdrop-blur">
            <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-blue-700">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Export selected search
            </p>

            <div className="mt-5 flex items-center gap-3">
              <select
                className="h-12 flex-1 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
                onChange={(event) => setFormat(event.target.value as 'xlsx' | 'csv')}
                value={format}
              >
                <option value="xlsx">Excel</option>
                <option value="csv">CSV</option>
              </select>

              <button
                className="inline-flex h-12 items-center gap-2 rounded-2xl bg-emerald-600 px-4 text-sm font-bold text-white shadow-lg shadow-emerald-600/20 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                disabled={!selectedLeads.length}
                onClick={handleDownload}
                type="button"
              >
                <Download className="h-4 w-4" />
                Download
              </button>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-500">
              Download the currently selected saved search in your preferred format.
            </p>
          </div>

          <div className="rounded-[2rem] border border-slate-200 bg-white/90 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
              Saved searches
            </p>

            <div className="mt-4 flex items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-500">Library size</p>
                <p className="mt-1 text-3xl font-black tracking-[-0.04em] text-slate-950">
                  {sortedItems.length}
                </p>
              </div>

              <Link
                className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
                to="/search"
              >
                New search
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-500">
              Your latest search stays selected here for export or review.
            </p>
          </div>
        </div>
      </section>

      <section className="relative mx-auto grid max-w-7xl gap-4 px-4 pb-6 md:px-8 sm:grid-cols-2 xl:grid-cols-5">
        <HistoryStatCard label="Searches" value={sortedItems.length} />
        <HistoryStatCard label="Total leads" value={totalLeadCount} />
        <HistoryStatCard label="Requested" value={selectedItem?.count ?? 0} />
        <HistoryStatCard label="Email" value={selectedLeadStats.withEmail} />
        <HistoryStatCard label="Phone" value={selectedLeadStats.withPhone} />
      </section>

      <section className="relative mx-auto grid max-w-7xl gap-6 px-4 pb-28 md:px-8 lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="rounded-[2rem] border border-slate-200 bg-white/90 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur lg:sticky lg:top-6 lg:self-start">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
                Search list
              </p>
              <h2 className="mt-2 text-xl font-black tracking-[-0.035em] text-slate-950">
                Saved searches
              </h2>
            </div>

            <span className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700">
              {sortedItems.length}
            </span>
          </div>

          <div className="max-h-[680px] space-y-3 overflow-y-auto pr-1">
            {sortedItems.map((item) => {
              const active = item.id === selectedItem?.id;

              return (
                <button
                  className={[
                    'group w-full rounded-[1.4rem] border px-4 py-4 text-left transition',
                    active
                      ? 'border-blue-200 bg-blue-50 shadow-[0_16px_40px_rgba(37,99,235,0.12)]'
                      : 'border-slate-200 bg-slate-50/80 hover:border-blue-200 hover:bg-white',
                  ].join(' ')}
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-black text-slate-950">
                        {item.companyType || 'Untitled search'}
                      </p>

                      <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-600">
                        <MapPin className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">
                          {item.locationLabel ?? item.city ?? 'Unknown location'}
                        </span>
                      </p>
                    </div>

                    <span
                      className={[
                        'shrink-0 rounded-full px-2.5 py-1 text-xs font-bold',
                        active
                          ? 'bg-white text-blue-700'
                          : 'bg-white text-slate-500 group-hover:text-blue-700',
                      ].join(' ')}
                    >
                      {item.leadCount} leads
                    </span>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-slate-500">
                      {item.count} requested
                    </span>

                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                      <Clock3 className="h-3.5 w-3.5" />
                      {formatDate(item.createdAt)}
                    </span>
                  </div>
                </button>
              );
            })}

            {!sortedItems.length ? (
              <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-slate-500">
                  <Search className="h-6 w-6" />
                </div>

                <h3 className="mt-4 font-black tracking-[-0.03em] text-slate-950">
                  No saved searches yet
                </h3>

                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Run a search first. Completed searches will appear here automatically.
                </p>

                <Link
                  className="mt-5 inline-flex h-11 items-center gap-2 rounded-2xl bg-slate-950 px-4 text-sm font-bold text-white transition hover:bg-blue-700"
                  to="/search"
                >
                  Start searching
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            ) : null}
          </div>
        </aside>

        <div className="space-y-6">
          <section className="rounded-[2rem] border border-slate-200 bg-white/90 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
                  Search details
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <h2 className="text-3xl font-black tracking-[-0.045em] text-slate-950">
                    {selectedItem?.companyType ?? 'No search selected'}
                  </h2>

                  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600">
                    <MapPin className="h-3.5 w-3.5" />
                    {selectedItem?.locationLabel ?? selectedItem?.city ?? 'Select a search'}
                  </span>
                </div>

                <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
                  Review the stored leads from this search or download the full saved result set
                  again.
                </p>
              </div>

              <button
                className="inline-flex h-12 w-fit items-center gap-2 rounded-2xl bg-slate-950 px-4 text-sm font-bold text-white shadow-lg shadow-slate-900/15 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                disabled={!selectedLeads.length}
                onClick={handleDownload}
                type="button"
              >
                <Download className="h-4 w-4" />
                Export
              </button>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-[1.35rem] border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                  Requested
                </p>
                <p className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">
                  {selectedItem?.count ?? 0}
                </p>
              </div>

              <div className="rounded-[1.35rem] border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                  Leads
                </p>
                <p className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">
                  {selectedItem?.leadCount ?? 0}
                </p>
              </div>

              <div className="rounded-[1.35rem] border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                  Email
                </p>
                <p className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">
                  {selectedLeadStats.withEmail}
                </p>
              </div>

              <div className="rounded-[1.35rem] border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                  Phone
                </p>
                <p className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">
                  {selectedLeadStats.withPhone}
                </p>
              </div>

              <div className="rounded-[1.35rem] border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                  <CalendarClock className="h-3.5 w-3.5" />
                  Saved
                </p>
                <p className="mt-2 text-sm font-black leading-6 text-slate-950">
                  {selectedItem ? formatDate(selectedItem.createdAt) : '—'}
                </p>
              </div>
            </div>
          </section>

          <LeadsPreviewTable leads={selectedLeads} />
        </div>
      </section>
    </main>
  );
}
