import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Clock3,
  Copy,
  Download,
  MapPin,
  Plus,
  Search,
  Sparkles,
  TableProperties,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import { SessionAction } from '../components/auth/session-action';
import { useAuth } from '../hooks/use-auth';
import { useSearchHistoryDetails, type SearchHistoryItem } from '../hooks/use-search-history';
import { downloadLeads, defaultExportColumns } from '../utils/export';

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

const formatLeadLabel = (count: number) => `${count} lead${count === 1 ? '' : 's'}`;

const isWithinDays = (value: string, days: number) => {
  const timestamp = new Date(value).getTime();

  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Date.now() - timestamp <= days * 24 * 60 * 60 * 1000;
};

type HistoryTab = 'all' | 'week' | 'ready' | 'empty';

function HistoryMetricCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-[1.5rem] border border-slate-200 bg-white/90 p-5 shadow-[0_18px_60px_rgba(15,23,42,0.08)] backdrop-blur">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950">{value}</p>
        </div>

        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
          {icon}
        </div>
      </div>
    </div>
  );
}

function HistoryTabButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={[
        'inline-flex h-12 items-center gap-2 rounded-2xl border px-4 text-sm font-medium transition',
        active
          ? 'border-slate-950 bg-slate-950 text-white shadow-[0_10px_25px_rgba(15,23,42,0.15)]'
          : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:text-blue-700',
      ].join(' ')}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <span
        className={[
          'rounded-full px-2 py-0.5 text-[11px] font-semibold',
          active ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-500',
        ].join(' ')}
      >
        {count}
      </span>
    </button>
  );
}

function SearchHistoryTable({
  items,
  onCopySummary,
  onExportSearch,
  onResetFilters,
  hasAnyItems,
}: {
  hasAnyItems: boolean;
  items: SearchHistoryItem[];
  onCopySummary: (item: SearchHistoryItem) => void;
  onExportSearch: (item: SearchHistoryItem) => void;
  onResetFilters: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white/95 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
      <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
            <TableProperties className="h-3.5 w-3.5" />
            Saved searches
          </p>
          <h2 className="mt-2 text-xl font-black tracking-[-0.035em] text-slate-950">
            Search log
          </h2>
        </div>

        <span className="w-fit rounded-2xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700">
          {items.length} {items.length === 1 ? 'search' : 'searches'}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table
          aria-label="Saved search history"
          className="min-w-[980px] text-left text-sm text-slate-700"
        >
          <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-400">
            <tr>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Search</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Location</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Requested</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Leads</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Saved</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold">Status</th>
              <th className="whitespace-nowrap px-5 py-4 font-bold text-right">Actions</th>
            </tr>
          </thead>

          <tbody>
            {items.map((item) => {
              const ready = item.leadCount > 0;

              return (
                <tr className="border-t border-slate-100 transition hover:bg-slate-50/80" key={item.id}>
                  <td className="px-5 py-4">
                    <div className="font-bold text-slate-950">
                      {item.companyType || 'Untitled search'}
                    </div>
                    <div className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-400">
                      {ready ? `${formatLeadLabel(item.leadCount)} saved` : 'No leads saved'}
                    </div>
                  </td>

                  <td className="px-5 py-4">
                    <div className="inline-flex max-w-[260px] items-center gap-1.5 text-slate-700">
                      <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="truncate">
                        {item.locationLabel ?? item.city ?? 'Unknown location'}
                      </span>
                    </div>
                  </td>

                  <td className="whitespace-nowrap px-5 py-4 font-medium text-slate-700">
                    {item.count}
                  </td>

                  <td className="whitespace-nowrap px-5 py-4 font-medium text-slate-700">
                    {item.leadCount}
                  </td>

                  <td className="whitespace-nowrap px-5 py-4 text-slate-600">
                    {formatDate(item.createdAt)}
                  </td>

                  <td className="whitespace-nowrap px-5 py-4">
                    <span
                      className={[
                        'rounded-full px-3 py-1 text-xs font-bold',
                        ready ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500',
                      ].join(' ')}
                    >
                      {ready ? 'Ready' : 'Empty'}
                    </span>
                  </td>

                  <td className="px-5 py-4">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        aria-label={`Copy summary for ${item.companyType || 'saved search'}`}
                        className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-blue-200 hover:text-blue-700"
                        onClick={() => onCopySummary(item)}
                        type="button"
                      >
                        <Copy className="h-4 w-4" />
                      </button>

                      <button
                        aria-label={`Export ${item.companyType || 'saved search'}`}
                        className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-blue-200 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={!ready}
                        onClick={() => onExportSearch(item)}
                        type="button"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}

            {!items.length ? (
              <tr>
                <td className="px-5 py-16 text-center" colSpan={7}>
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
                    <Search className="h-7 w-7" />
                  </div>

                  <h3 className="mt-5 text-lg font-black tracking-[-0.03em] text-slate-950">
                    {hasAnyItems ? 'No searches match these filters' : 'No saved searches yet'}
                  </h3>

                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">
                    {hasAnyItems
                      ? 'Clear the filters to see every saved search again.'
                      : 'Run a search first. Saved searches will appear here automatically.'}
                  </p>

                  <div className="mt-5 flex flex-wrap justify-center gap-3">
                    {hasAnyItems ? (
                      <button
                        className="inline-flex h-11 items-center gap-2 rounded-2xl bg-slate-950 px-4 text-sm font-bold text-white transition hover:bg-blue-700"
                        onClick={onResetFilters}
                        type="button"
                      >
                        Reset filters
                      </button>
                    ) : null}

                    <Link
                      className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
                      to="/search"
                    >
                      Start searching
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </div>
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
  const [activeTab, setActiveTab] = useState<HistoryTab>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const sortedItems = useMemo(() => {
    return [...items].sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    );
  }, [items]);

  const totalLeadCount = useMemo(
    () => sortedItems.reduce((total, item) => total + (item.leadCount ?? item.leads.length), 0),
    [sortedItems],
  );

  const todayCount = useMemo(
    () => sortedItems.filter((item) => isWithinDays(item.createdAt, 1)).length,
    [sortedItems],
  );

  const weekCount = useMemo(
    () => sortedItems.filter((item) => isWithinDays(item.createdAt, 7)).length,
    [sortedItems],
  );

  const monthCount = useMemo(
    () => sortedItems.filter((item) => isWithinDays(item.createdAt, 30)).length,
    [sortedItems],
  );

  const emptyCount = useMemo(
    () => sortedItems.filter((item) => item.leadCount === 0).length,
    [sortedItems],
  );

  const readyCount = sortedItems.length - emptyCount;

  const visibleItems = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return sortedItems.filter((item) => {
      if (activeTab === 'week' && !isWithinDays(item.createdAt, 7)) {
        return false;
      }

      if (activeTab === 'ready' && item.leadCount === 0) {
        return false;
      }

      if (activeTab === 'empty' && item.leadCount > 0) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        item.companyType,
        item.locationLabel,
        item.city,
        item.searchId ?? '',
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [activeTab, searchQuery, sortedItems]);

  const handleExportSearch = (item: SearchHistoryItem) => {
    if (!item.leads.length) {
      toast.error('No leads are saved for this search');
      return;
    }

    downloadLeads(item.leads, {
      fileName: buildFileName(item.companyType, item.locationLabel, item.createdAt),
      format: 'xlsx',
      columns: [...defaultExportColumns],
    });

    toast.success('Export started');
  };

  const handleCopySummary = async (item: SearchHistoryItem) => {
    const summary = [
      item.companyType || 'Untitled search',
      item.locationLabel ?? item.city ?? 'Unknown location',
      formatLeadLabel(item.leadCount),
    ].join(' · ');

    try {
      await navigator.clipboard.writeText(summary);
      toast.success('Search summary copied');
    } catch {
      toast.error('Copy failed');
    }
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

      <section className="relative mx-auto flex max-w-7xl flex-col gap-6 px-4 pb-6 pt-3 md:px-8">
        <div className="overflow-hidden rounded-[2rem] border border-white/70 bg-white/90 p-6 shadow-[0_30px_100px_rgba(15,23,42,0.10)] backdrop-blur md:p-8 lg:p-10">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-4 py-2 text-xs font-bold uppercase tracking-[0.22em] text-blue-700">
                <Clock3 className="h-3.5 w-3.5" />
                Search history
              </p>

              <h1 className="mt-6 max-w-3xl text-4xl font-black leading-[0.95] tracking-[-0.06em] text-slate-950 sm:text-5xl xl:text-6xl">
                Reopen, review, and export past searches.
              </h1>

              <p className="mt-5 max-w-2xl text-base leading-7 text-slate-500 md:text-lg">
                Track {sortedItems.length} searches and {totalLeadCount} saved leads in one compact
                log.
              </p>
            </div>

            <Link
              className="inline-flex h-12 items-center gap-2 self-start rounded-2xl bg-blue-600 px-5 text-sm font-bold text-white shadow-[0_18px_50px_rgba(37,99,235,0.24)] transition hover:bg-blue-700"
              to="/search"
            >
              <Plus className="h-4 w-4" />
              New search
            </Link>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <HistoryMetricCard icon={<CalendarClock className="h-5 w-5" />} label="Today" value={todayCount} />
          <HistoryMetricCard icon={<Search className="h-5 w-5" />} label="This week" value={weekCount} />
          <HistoryMetricCard icon={<Sparkles className="h-5 w-5" />} label="This month" value={monthCount} />
          <HistoryMetricCard
            icon={<AlertTriangle className="h-5 w-5" />}
            label="Empty searches"
            value={emptyCount}
          />
        </div>

        <div className="rounded-[2rem] border border-slate-200 bg-white/95 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
          <div className="flex flex-wrap gap-3">
            <HistoryTabButton
              active={activeTab === 'all'}
              count={sortedItems.length}
              label="All searches"
              onClick={() => setActiveTab('all')}
            />
            <HistoryTabButton
              active={activeTab === 'week'}
              count={weekCount}
              label="This week"
              onClick={() => setActiveTab('week')}
            />
            <HistoryTabButton
              active={activeTab === 'ready'}
              count={readyCount}
              label="Ready to export"
              onClick={() => setActiveTab('ready')}
            />
            <HistoryTabButton
              active={activeTab === 'empty'}
              count={emptyCount}
              label="Empty"
              onClick={() => setActiveTab('empty')}
            />
          </div>

          <label className="relative mt-5 block">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="h-14 w-full rounded-2xl border border-slate-200 bg-white px-11 text-sm font-medium text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by company or location"
              value={searchQuery}
            />
          </label>
        </div>

        <SearchHistoryTable
          hasAnyItems={sortedItems.length > 0}
          items={visibleItems}
          onCopySummary={(item) => void handleCopySummary(item)}
          onExportSearch={(item) => void handleExportSearch(item)}
          onResetFilters={() => {
            setActiveTab('all');
            setSearchQuery('');
          }}
        />
      </section>

      <Link
        aria-label="New search"
        className="fixed bottom-5 right-5 z-40 hidden h-16 w-16 items-center justify-center rounded-full bg-blue-600 text-white shadow-[0_24px_60px_rgba(37,99,235,0.35)] transition hover:bg-blue-700 lg:flex"
        to="/search"
      >
        <Plus className="h-6 w-6" />
      </Link>
    </main>
  );
}
