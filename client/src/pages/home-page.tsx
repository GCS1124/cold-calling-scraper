import { motion } from 'framer-motion';
import { AlertTriangle, Download, Sparkles, Zap } from 'lucide-react';
import { startTransition, useDeferredValue, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ExportModal } from '../components/export/export-modal';
import { FiltersPanel } from '../components/results/filters-panel';
import { ResultsSummary } from '../components/results/results-summary';
import { ResultsTable } from '../components/results/results-table';
import { RecentSearches } from '../components/search/recent-searches';
import { SearchForm } from '../components/search/search-form';
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
  const [invalidLeadIds, setInvalidLeadIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [filters, setFilters] = useState({
    hasEmail: false,
    hasPhone: false,
    hasWebsite: false,
    source: 'All',
    includePartials: false,
    showRejected: false,
  });
  const { items, rememberSearch } = useSearchHistory();
  const searchInFlight = Boolean(
    result?.meta.status && ['queued', 'discovering', 'enriching', 'qualifying'].includes(result.meta.status),
  );

  const visibleLeads = (result?.leads ?? [])
    .filter((lead) => !invalidLeadIds.includes(lead.id))
    .filter((lead) => {
      if (lead.qualified) {
        return true;
      }

      const isPartial = lead.hasEmail || lead.hasPhone;
      if (filters.showRejected) {
        return true;
      }

      return (filters.includePartials || searchInFlight) && isPartial;
    })
    .filter((lead) => (filters.hasEmail ? lead.hasEmail : true))
    .filter((lead) => (filters.hasPhone ? lead.hasPhone : true))
    .filter((lead) => (filters.hasWebsite ? lead.hasWebsite : true))
    .filter((lead) => (filters.source === 'All' ? true : lead.source.includes(filters.source)))
    .toSorted((left, right) => right.confidence - left.confidence);

  const deferredLeads = useDeferredValue(visibleLeads);
  const qualifiedVisibleLeads = deferredLeads.filter((lead) => lead.qualified);
  const exportableLeads = selectedIds.length
    ? qualifiedVisibleLeads.filter((lead) => selectedIds.includes(lead.id))
    : qualifiedVisibleLeads;
  const sources = [...new Set((result?.leads ?? []).map((lead) => lead.source))];

  const summary = {
    total: qualifiedVisibleLeads.length,
    withEmail: deferredLeads.filter((lead) => lead.hasEmail).length,
    withPhone: deferredLeads.filter((lead) => lead.hasPhone).length,
    withWebsite: deferredLeads.filter((lead) => lead.hasWebsite).length,
    missingEmail: (result?.leads ?? []).filter((lead) => lead.rejectionReason === 'missing_email')
      .length,
    missingPhone: (result?.leads ?? []).filter((lead) =>
      ['missing_phone', 'invalid_phone'].includes(lead.rejectionReason ?? ''),
    ).length,
  };
  const hiddenCandidateCount = (result?.leads ?? []).filter(
    (lead) => !invalidLeadIds.includes(lead.id) && !lead.qualified,
  ).length;
  const emptyStateMessage =
    !result?.leads.length && searchInFlight
      ? 'Still discovering source candidates. Qualified contacts will appear here as enrichment progresses.'
      : !qualifiedVisibleLeads.length && hiddenCandidateCount > 0 && !filters.includePartials && !filters.showRejected
        ? `Discovered ${hiddenCandidateCount} unqualified candidates. Enable "Include partial leads" to preview them while enrichment runs.`
        : 'No leads match the current filters.';

  useEffect(() => {
    if (
      !result?.searchId ||
      !['queued', 'discovering', 'enriching', 'qualifying'].includes(result.meta.status)
    ) {
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const nextResult = await searchApi.getSearch(result.searchId);
        startTransition(() => {
          setResult(nextResult);
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Search update failed');
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

    try {
      const response = await searchApi.startSearch(nextSearch);
      rememberSearch({
        ...nextSearch,
        city: response.meta.locationLabel || nextSearch.city,
      });

      startTransition(() => {
        setResult(response);
        setSelectedIds([]);
        setInvalidLeadIds([]);
      });

      if (response.meta.providerWarnings.length) {
        toast.warning(
          `${response.meta.providerWarnings.length} provider warning${
            response.meta.providerWarnings.length === 1 ? '' : 's'
          } returned. Results are partial.`,
        );
      }
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
    const value = [lead.name, lead.mobile, lead.email, lead.website, lead.source].join(',');
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
              Search US businesses by category and metro area, blend live APIs with
              open mapping discovery and direct website crawling, then export a clean
              outbound list without leaving the browser.
            </p>

            <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-2">
              <div className="rounded-[22px] border border-white/70 bg-white/72 p-4 shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Visual Thesis
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Editorial first viewport, quiet data surfaces, and a US-market search
                  workflow built for speed.
                </p>
              </div>
              <div className="rounded-[22px] border border-white/70 bg-white/72 p-4 shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Interaction Thesis
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Search-first motion, quick table scanning, and export readiness for US
                  lead lists without clutter.
                </p>
              </div>
            </div>
          </motion.div>

          <motion.div
            animate={{ opacity: 1, scale: 1 }}
            initial={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.45, delay: 0.08 }}
          >
            <SearchForm loading={loading} onChange={setSearch} onSubmit={() => handleSearch()} value={search} />
            <div className="mt-4">
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
          qualified={result?.meta.progress.qualifiedCount ?? summary.total}
          requested={result?.meta.progress.requestedCount ?? search.count}
          missingEmail={summary.missingEmail}
          missingPhone={summary.missingPhone}
          blocked={result?.meta.progress.blockedCount ?? 0}
          duplicatesRemoved={result?.meta.progress.duplicatesRemoved ?? 0}
        />

        <section className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="space-y-6">
            <FiltersPanel filters={filters} onChange={setFilters} sources={sources} />

            <div className="rounded-[24px] border border-slate-200 bg-slate-950 p-5 text-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
              <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-blue-200">
                <Zap className="h-3.5 w-3.5" />
                Export Queue
              </p>
              <p className="mt-4 text-3xl font-semibold">{exportableLeads.length}</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                {selectedIds.length
                  ? 'Selected rows ready for download.'
                  : 'Qualified leads only are export-ready by default.'}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            {result ? (
              <div className="rounded-[24px] border border-slate-200 bg-white px-5 py-4 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Search Status
                </p>
                <p className="mt-2 text-sm font-medium text-slate-900">
                  {result.meta.status === 'queued'
                    ? `Queued ${result.meta.progress.requestedCount} requested leads`
                    : result.meta.status === 'discovering'
                    ? `Discovering businesses in ${result.meta.locationLabel}`
                    : result.meta.status === 'enriching'
                      ? `Enriching ${result.meta.progress.enriched} of ${result.meta.progress.totalCandidates} candidates`
                      : result.meta.status === 'qualifying'
                        ? `Qualifying ${result.meta.progress.qualifiedCount} of ${result.meta.progress.requestedCount} requested leads`
                      : result.meta.status === 'failed'
                        ? 'Search failed'
                        : 'Complete'}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  Query: {result.meta.query}
                </p>
                <div className="mt-3 grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
                  <p>Current source: {result.meta.progress.currentSource}</p>
                  <p>Blocked: {result.meta.progress.blockedCount}</p>
                  <p>Discarded: {result.meta.progress.discardedCount}</p>
                  <p>Qualified: {result.meta.progress.qualifiedCount}</p>
                  <p>Batches: {result.meta.progress.batchesCompleted}</p>
                  <p>Remaining: {result.meta.progress.estimatedRemaining}</p>
                </div>
              </div>
            ) : null}

            {result?.meta.providerWarnings.length ? (
              <div className="rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
                <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Source Warnings
                </p>
                <ul className="mt-3 space-y-2 text-sm">
                  {result.meta.providerWarnings.map((warning, index) => (
                    <li key={`${warning.providerId}-${index}`}>
                      <span className="font-semibold">{warning.providerName}:</span>{' '}
                      {warning.message}
                    </li>
                  ))}
                </ul>
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
            ) : (
              <ResultsTable
                emptyStateMessage={emptyStateMessage}
                leads={deferredLeads}
                onCopyRow={(lead) => void handleCopyRow(lead)}
                onFlagInvalid={(leadId) =>
                  setInvalidLeadIds((current) => [...current, leadId])
                }
                onSelectAll={toggleSelectAll}
                onToggleSelect={toggleSelected}
                selectedIds={selectedIds}
              />
            )}
          </div>
        </section>
      </main>

      <div className="sticky bottom-4 z-40 mx-auto flex w-[min(100%-2rem,1120px)] items-center justify-between gap-4 rounded-[24px] border border-slate-200 bg-white/92 px-5 py-4 shadow-[0_24px_80px_rgba(15,23,42,0.12)] backdrop-blur">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
            Ready to export
          </p>
          <p className="mt-1 text-sm text-slate-700">
            {selectedIds.length
              ? `${selectedIds.length} selected rows`
              : `${qualifiedVisibleLeads.length} qualified visible leads`}
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

      <ExportModal leads={exportableLeads} onClose={() => setShowExport(false)} open={showExport} />
    </>
  );
}
