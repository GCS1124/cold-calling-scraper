import { motion } from 'framer-motion';
import { Clock3, Download, LoaderCircle, Sparkles, UserRound, Zap } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';

import { ExportModal } from '../components/export/export-modal';
import { FiltersPanel } from '../components/results/filters-panel';
import { ResultsSummary } from '../components/results/results-summary';
import { ResultsTable } from '../components/results/results-table';
import { RecentSearches } from '../components/search/recent-searches';
import { SearchForm } from '../components/search/search-form';
import { useAuth } from '../hooks/use-auth';
import { useSearchHistory } from '../hooks/use-search-history';
import type { SearchApi } from '../services/search-service';
import type { Lead, SearchRequest, SearchResponse } from '../types/lead';

type HomePageProps = {
  searchApi: SearchApi;
};

const initialSearch: SearchRequest = {
  companyType: '',
  city: '',
  count: 50,
};

export function HomePage({ searchApi }: HomePageProps) {
  const [search, setSearch] = useState<SearchRequest>(initialSearch);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [submittedSearch, setSubmittedSearch] = useState<SearchRequest | null>(null);
  const [filters, setFilters] = useState({
    hasEmail: false,
    hasPhone: false,
    hasWebsite: false,
  });
  const auth = useAuth();
  const { items, rememberSearch } = useSearchHistory(auth.user?.id);
  const recordedSearchId = useRef<string | null>(null);
  const isPollingRef = useRef(false);

  const visibleLeads = (result?.leads ?? [])
    .filter((lead) => {
      if (filters.hasEmail && !lead.hasEmail) return false;
      if (filters.hasPhone && !lead.hasPhone) return false;
      if (filters.hasWebsite && !lead.hasWebsite) return false;
      return true;
    })
    .toSorted((left, right) => right.confidence - left.confidence);

  const deferredLeads = useDeferredValue(visibleLeads);
  const exportableLeads = selectedIds.length
    ? visibleLeads.filter((lead) => selectedIds.includes(lead.id))
    : visibleLeads;
  const isWaiting = Boolean(
    result && !['complete', 'failed'].includes(result.meta.status),
  );

  const summary = {
    total: deferredLeads.length,
    withEmail: deferredLeads.filter((lead) => lead.hasEmail).length,
    withPhone: deferredLeads.filter((lead) => lead.hasPhone).length,
    withWebsite: deferredLeads.filter((lead) => lead.hasWebsite).length,
    missingEmail: (result?.leads ?? []).filter((lead) => lead.rejectionReason === 'missing_email')
      .length,
    missingPhone: (result?.leads ?? []).filter((lead) =>
      ['missing_phone', 'invalid_phone'].includes(lead.rejectionReason ?? ''),
    ).length,
  };
  const emptyStateMessage =
    !result?.leads.length && result
      ? 'Still finding leads.'
      : 'No leads match the current filters.';

  useEffect(() => {
    if (!result || result.meta.status !== 'complete' || !submittedSearch) {
      return;
    }

    if (recordedSearchId.current === result.searchId) {
      return;
    }

    recordedSearchId.current = result.searchId;
    void rememberSearch(submittedSearch, {
      locationLabel: result.meta.locationLabel,
      searchId: result.searchId,
      leads: result.leads,
    });
  }, [rememberSearch, result, submittedSearch]);

  useEffect(() => {
    if (
      !result?.searchId ||
      !['queued', 'discovering', 'enriching'].includes(result.meta.status)
    ) {
      return;
    }

    if (isPollingRef.current) {
      return;
    }

    const timer = window.setTimeout(async () => {
      isPollingRef.current = true;
      try {
        const nextResult = await searchApi.getSearch(result.searchId);
        setResult(nextResult);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Search update failed');
      } finally {
        isPollingRef.current = false;
      }
    }, 1500);

    return () => window.clearTimeout(timer);
  }, [
    result?.searchId,
    result?.meta.status,
    result?.meta.progress.discovered,
    result?.meta.progress.enriched,
    searchApi,
  ]);

  const handleSearch = async (override?: SearchRequest) => {
    const nextSearch = override ?? search;

    setLoading(true);
    setSubmittedSearch(nextSearch);

    try {
      const response = await searchApi.startSearch(nextSearch);

      setResult(response);
      setSelectedIds([]);

    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const toggleSelected = (leadId: string) => {
    setSelectedIds((current) =>
      current.includes(leadId)
        ? current.filter((item) => item !== leadId)
        : [...current, leadId],
    );
  };

  const toggleSelectAll = () => {
    const visibleIds = deferredLeads.map((lead) => lead.id);
    const allVisibleSelected = visibleIds.every((id) => selectedIds.includes(id));

    setSelectedIds(allVisibleSelected ? [] : visibleIds);
  };

  const handleCopyRow = async (lead: Lead) => {
    const value = [lead.name, lead.mobile, lead.email, lead.website, lead.address, lead.source].join(',');
    await navigator.clipboard.writeText(value);
    toast.success('Lead copied as CSV');
  };

  return (
    <>
      <section className="relative overflow-hidden px-4 pb-12 pt-6 md:px-8 md:pt-8">
        <div className="absolute inset-x-8 top-0 h-[420px] rounded-[40px] bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.18),_transparent_42%),radial-gradient(circle_at_80%_20%,_rgba(15,118,110,0.16),_transparent_30%),linear-gradient(135deg,_rgba(255,255,255,0.95),_rgba(239,246,255,0.88))]" />
        <div className="relative mx-auto grid max-w-7xl gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="pt-6"
            initial={{ opacity: 0, y: 18 }}
            transition={{ duration: 0.45 }}
          >
            <p className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-blue-700 shadow-[0_10px_35px_rgba(37,99,235,0.12)]">
              <Sparkles className="h-3.5 w-3.5" />
              Lead Finder Pro
            </p>

            <h1 className="mt-6 max-w-xl text-[clamp(3rem,7vw,5.6rem)] font-extrabold leading-[0.92] tracking-[-0.06em] text-slate-950">
              Find leads in seconds.
            </h1>

            <p className="mt-5 max-w-lg text-base leading-7 text-slate-600 md:text-lg">
              Search US businesses by category and metro area using structured APIs and
              mapping data, then export a clean outbound list without leaving the browser.
            </p>

          </motion.div>

          <motion.div
            animate={{ opacity: 1, scale: 1 }}
            initial={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.45, delay: 0.08 }}
          >
            <div className="space-y-4">
              <div className="flex justify-end">
                <div className="flex items-center gap-2">
                  <Link
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-4 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
                    to="/history"
                  >
                    <Clock3 className="h-4 w-4" />
                    History
                  </Link>
                  <Link
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-4 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
                    to="/"
                  >
                    <UserRound className="h-4 w-4" />
                    Account
                  </Link>
                </div>
              </div>
              <SearchForm loading={loading} onChange={setSearch} onSubmit={() => handleSearch()} value={search} />
              <RecentSearches
                items={items}
                onApply={(item) => {
                  const nextSearch = {
                    companyType: item.companyType,
                    city: item.city,
                    count: item.count,
                  };
                  setSearch(nextSearch);
                  void handleSearch(nextSearch);
                }}
              />
            </div>
          </motion.div>
        </div>
      </section>

      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 pb-28 md:px-8">
        <ResultsSummary
          city={result?.meta.locationLabel || search.city}
          companyType={search.companyType}
          found={result?.meta.progress.foundCount ?? summary.total}
          requested={result?.meta.progress.requestedCount ?? search.count}
          missingEmail={summary.missingEmail}
          missingPhone={summary.missingPhone}
          duplicatesRemoved={result?.meta.progress.duplicatesRemoved ?? 0}
        />

        {result ? (
          <div className="rounded-[24px] border border-slate-200 bg-white px-5 py-4 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Search Status
            </p>
            <p className="mt-2 text-sm font-medium text-slate-900">
              {result.meta.status === 'queued'
                ? `Queued ${result.meta.progress.requestedCount} leads`
                : result.meta.status === 'discovering'
                ? `Finding leads in ${result.meta.locationLabel}`
                : result.meta.status === 'enriching'
                  ? 'Collecting details'
                  : result.meta.status === 'failed'
                    ? 'Search failed'
                    : 'Search complete'}
            </p>
            <p className="mt-1 text-sm text-slate-600">Query: {result.meta.query}</p>
            <div className="mt-3 grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
              <p>Found: {result.meta.progress.foundCount}</p>
              <p>Requested: {result.meta.progress.requestedCount}</p>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="grid gap-4">
            {[0, 1, 2].map((item) => (
              <div
                className="h-24 animate-pulse rounded-[24px] border border-slate-200 bg-white"
                key={item}
              />
            ))}
          </div>
        ) : isWaiting ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
            <div className="flex items-center gap-3 text-slate-900">
              <LoaderCircle className="h-5 w-5 animate-spin text-blue-600" />
              <p className="text-lg font-semibold">Finding leads</p>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Waiting for the search to finish. Results and export will appear here when the
              job completes.
            </p>
            <div className="mt-6 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-600" />
            </div>
          </div>
        ) : (
          <section className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="space-y-6">
              <FiltersPanel filters={filters} onChange={setFilters} />

              <div className="rounded-[24px] border border-slate-200 bg-slate-950 p-5 text-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
                <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-blue-200">
                  <Zap className="h-3.5 w-3.5" />
                  Export Queue
                </p>
                <p className="mt-4 text-3xl font-semibold">{visibleLeads.length}</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  {selectedIds.length
                    ? 'Selected rows ready for download.'
                    : 'Leads found are export-ready by default.'}
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {result ? (
                <ResultsTable
                  emptyStateMessage={emptyStateMessage}
                  leads={deferredLeads}
                  onCopyRow={(lead) => void handleCopyRow(lead)}
                  onSelectAll={toggleSelectAll}
                  onToggleSelect={toggleSelected}
                  selectedIds={selectedIds}
                />
              ) : null}
            </div>
          </section>
        )}
      </main>

      {!isWaiting && result ? (
        <div className="sticky bottom-4 z-40 mx-auto flex w-[min(100%-2rem,1120px)] items-center justify-between gap-4 rounded-[24px] border border-slate-200 bg-white/92 px-5 py-4 shadow-[0_24px_80px_rgba(15,23,42,0.12)] backdrop-blur">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Ready to export
            </p>
            <p className="mt-1 text-sm text-slate-700">
              {selectedIds.length
                ? `${selectedIds.length} selected rows`
                : `${visibleLeads.length} leads found`}
            </p>
          </div>
          <button
            className="inline-flex h-12 items-center gap-2 rounded-2xl bg-emerald-600 px-5 text-sm font-semibold text-white transition hover:bg-emerald-700"
            onClick={() => setShowExport(true)}
            type="button"
          >
            <Download className="h-4 w-4" />
            Download Excel
          </button>
        </div>
      ) : null}

      <ExportModal leads={exportableLeads} onClose={() => setShowExport(false)} open={showExport} />
    </>
  );
}
