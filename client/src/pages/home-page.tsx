import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  Filter,
  LoaderCircle,
  MapPin,
  Search,
  Sparkles,
  Zap,
  BriefcaseBusiness,
} from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import { ExportModal } from '../components/export/export-modal';
import { SessionAction } from '../components/auth/session-action';
import { FiltersPanel } from '../components/results/filters-panel';
import { ResultsSummary } from '../components/results/results-summary';
import { ResultsTable } from '../components/results/results-table';
import { SearchForm } from '../components/search/search-form';
import { useAuth } from '../hooks/use-auth';
import { useSearchHistory } from '../hooks/use-search-history';
import { isRetryableSearchError, type SearchApi } from '../services/search-service';
import {
  buildSearchRequestFromDraft,
  createSearchDraft,
  formatLocationLabel,
} from '../utils/search-location';
import { sourceModeLabelsByCode } from '../data/search-options';
import type { Lead, SearchDraft, SearchRequest, SearchResponse } from '../types/lead';

type HomePageProps = {
  searchApi: SearchApi;
};

const pollingStatuses = ['queued', 'discovering', 'enriching'];

function toCsvField(value: string | number | null | undefined) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export function HomePage({ searchApi }: HomePageProps) {
  const [search, setSearch] = useState<SearchDraft>(() => createSearchDraft());
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [submittedSearch, setSubmittedSearch] = useState<SearchRequest | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const [filters, setFilters] = useState({
    hasEmail: false,
    hasPhone: false,
    hasWebsite: false,
    highFitOnly: false,
    crossSourceOnly: false,
  });

  const auth = useAuth();
  const { rememberSearch } = useSearchHistory(auth.user?.id);
  const recordedSearchId = useRef<string | null>(null);
  const isPollingRef = useRef(false);

  const handleSourceModeChange = (sourceMode: SearchDraft['sourceMode']) => {
    setResult(null);
    setSubmittedSearch(null);
    setPollError(null);
    setSelectedIds([]);
    setShowExport(false);
    setFilters({
      hasEmail: false,
      hasPhone: false,
      hasWebsite: false,
      highFitOnly: false,
      crossSourceOnly: false,
    });

    if (sourceMode !== search.sourceMode) {
      recordedSearchId.current = null;
    }
  };

  const activeSourceMode = submittedSearch?.sourceMode ?? search.sourceMode;
  const activeSourceLabel = sourceModeLabelsByCode[activeSourceMode];

  const visibleLeads = useMemo(() => {
    return (result?.leads ?? [])
      .filter((lead) => {
        if (filters.hasEmail && !lead.hasEmail) return false;
        if (filters.hasPhone && !lead.hasPhone) return false;
        if (filters.hasWebsite && !lead.hasWebsite) return false;
        if (activeSourceMode === 'linkedin' && filters.highFitOnly && lead.confidence < 85) {
          return false;
        }
        if (
          activeSourceMode === 'linkedin' &&
          filters.crossSourceOnly &&
          (lead.matchSignals?.publicSources ?? 0) < 2
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.confidence - left.confidence);
  }, [
    activeSourceMode,
    filters.crossSourceOnly,
    filters.hasEmail,
    filters.hasPhone,
    filters.hasWebsite,
    filters.highFitOnly,
    result?.leads,
  ]);

  const deferredLeads = useDeferredValue(visibleLeads);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const exportableLeads = useMemo(() => {
    if (!selectedIds.length) return visibleLeads;
    return visibleLeads.filter((lead) => selectedIdSet.has(lead.id));
  }, [selectedIdSet, selectedIds.length, visibleLeads]);

  const isWaiting = Boolean(
    result && !['complete', 'failed'].includes(result.meta.status),
  );

  const summary = useMemo(() => {
    const allLeads = result?.leads ?? [];

    return {
      total: deferredLeads.length,
      withEmail: deferredLeads.filter((lead) => lead.hasEmail).length,
      withPhone: deferredLeads.filter((lead) => lead.hasPhone).length,
      withWebsite: deferredLeads.filter((lead) => lead.hasWebsite).length,
      publicContacts: deferredLeads.filter((lead) => lead.hasEmail || lead.hasPhone).length,
      missingEmail: allLeads.filter((lead) => !lead.hasEmail).length,
      missingPhone: allLeads.filter((lead) => !lead.hasPhone).length,
    };
  }, [deferredLeads, result?.leads]);

  const progressBasis = result
    ? Math.max(
        result.meta.progress.discovered ?? 0,
        result.meta.progress.enriched ?? 0,
        result.meta.progress.foundCount ?? 0,
      )
    : 0;

  const requestedCount = result?.meta.progress.requestedCount ?? search.count;
  const publicContactsFound =
    result?.meta.progress.publicContactsFound ?? summary.publicContacts;
  const publicQueriesAttempted = result?.meta.progress.publicQueriesAttempted;
  const publicProvidersChecked = result?.meta.progress.publicProvidersChecked;
  const aiProviderCoverage = result?.meta.progress.providerCoverage ?? [];
  const displayedProviderWarnings =
    activeSourceMode === 'ai'
      ? (result?.meta.providerWarnings ?? []).filter(
          (warning) => warning.providerId !== 'ai-mode-policy',
        )
      : result?.meta.providerWarnings ?? [];
  const linkedinQuality = useMemo(() => {
    const linkedinLeads = (result?.leads ?? []).filter((lead) =>
      lead.source.toLowerCase().includes('linkedin'),
    );

    return {
      highFit: linkedinLeads.filter((lead) => lead.confidence >= 85).length,
      corroborated: linkedinLeads.filter(
        (lead) => (lead.matchSignals?.publicSources ?? 0) > 1,
      ).length,
      roleSignals: linkedinLeads.filter((lead) => lead.matchSignals?.roleMatched).length,
    };
  }, [result?.leads]);
  const linkedinDiscoveryBlocked = Boolean(
    result &&
      activeSourceMode === 'linkedin' &&
      result.meta.status === 'complete' &&
      result.leads.length === 0 &&
      result.meta.providerWarnings.some(
        (warning) =>
          warning.providerId === 'linkedin-search' &&
          /blocked|rate-limited/i.test(warning.message),
      ),
  );
  const resultsExhausted =
    result !== null &&
    result.meta.status === 'complete' &&
    result.meta.progress.foundCount < result.meta.progress.requestedCount;
  const canRetryEmptyLinkedInSearch = Boolean(
    result &&
      activeSourceMode === 'linkedin' &&
      result.meta.status === 'complete' &&
      result.leads.length === 0,
  );

  const progressPercent = result
    ? Math.min(
        100,
        Math.max(
          isWaiting ? 12 : 0,
          Math.round((progressBasis / Math.max(1, requestedCount)) * 100),
        ),
      )
    : 0;

  const statusTitle = result
    ? result.meta.status === 'queued'
      ? `Queued ${result.meta.progress.requestedCount} leads`
      : result.meta.status === 'discovering'
        ? `Finding ${activeSourceMode === 'linkedin' ? 'prospects' : activeSourceMode === 'ai' ? 'AI-matched leads' : 'leads'} in ${result.meta.locationLabel}`
        : result.meta.status === 'enriching'
          ? 'Collecting contact details'
          : result.meta.status === 'failed'
            ? 'Search failed'
            : linkedinDiscoveryBlocked
              ? 'LinkedIn discovery blocked'
              : activeSourceMode === 'linkedin'
                ? 'Public LinkedIn discovery complete'
                : resultsExhausted
                  ? 'Discovery complete'
                  : 'Search complete'
    : '';

  const statusDescription = result
    ? result.meta.status === 'queued'
      ? `Your ${activeSourceLabel} search is waiting to begin.`
      : result.meta.status === 'discovering'
        ? activeSourceMode === 'linkedin'
          ? 'Searching public LinkedIn profiles, capturing matched prospects, and removing duplicates.'
          : activeSourceMode === 'ai'
            ? 'Running free public discovery in parallel, merging duplicates, and keeping source limitations visible.'
            : 'Scanning matching businesses and removing duplicates.'
          : result.meta.status === 'enriching'
              ? 'Adding emails, phone numbers, websites, and source details.'
              : result.meta.status === 'failed'
                  ? 'The search could not be completed. Adjust the query and try again.'
                    : linkedinDiscoveryBlocked
                      ? 'Free public-search providers temporarily blocked this request. No unverified or fabricated leads were added.'
                      : activeSourceMode === 'linkedin'
                        ? 'Profiles were ranked using public category, role, location, and cross-source signals. Contact fields are populated only from public websites.'
                        : activeSourceMode === 'ai'
                          ? 'Free public AI matching finished. Results were deduplicated, and contact details were kept only when publicly listed.'
                          : resultsExhausted
                            ? 'We verified the available businesses and stopped once the discovery sources stopped returning new results.'
                            : 'Your leads are ready to review, filter, copy, and export.'
    : '';

  const emptyStateMessage =
    result && result.leads.length === 0
      ? result.meta.status === 'complete'
        ? linkedinDiscoveryBlocked
          ? 'LinkedIn discovery was blocked by the free public-search providers. Try again later or switch location.'
          : activeSourceMode === 'ai'
            ? 'Free AI mode found no verified public leads. Try a broader category or location; paid sources are not used.'
          : 'No leads were found for this search. Try a broader company type or different location.'
        : 'Still finding leads.'
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
    if (!result?.searchId || !pollingStatuses.includes(result.meta.status)) {
      return;
    }

    let cancelled = false;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const poll = async () => {
      let firstTick = true;
      let transientFailures = 0;

      while (!cancelled) {
        if (firstTick) {
          firstTick = false;
        } else {
          await sleep(1500);
        }

        if (cancelled) {
          return;
        }

        isPollingRef.current = true;

        try {
          const nextResult = await searchApi.getSearch(result.searchId);
          if (cancelled) {
            return;
          }

          if (!nextResult) {
            setResult((current) =>
              current
                ? {
                    ...current,
                    meta: {
                      ...current.meta,
                      status: 'complete',
                      progress: {
                        ...current.meta.progress,
                        currentSource: 'Complete',
                      },
                    },
                  }
                : current,
            );
            return;
          }

          transientFailures = 0;
          setPollError(null);
          setResult(nextResult);

          if (!pollingStatuses.includes(nextResult.meta.status)) {
            return;
          }
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : 'Search update failed';

            if (isRetryableSearchError(error)) {
              transientFailures += 1;
              const retryDelay = Math.min(
                10_000,
                1_500 * 2 ** Math.min(transientFailures - 1, 3),
              );
              setPollError(`${message} Retrying status check automatically.`);
              await sleep(retryDelay);
              continue;
            }

            setPollError(message);
            toast.error(message);
          }
          return;
        } finally {
          isPollingRef.current = false;
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      isPollingRef.current = false;
    };
  }, [pollRevision, result?.meta.status, result?.searchId, searchApi]);

  const handleSearch = async (override?: SearchRequest) => {
    const nextSearch = override ?? buildSearchRequestFromDraft(search);

    setLoading(true);
    setSubmittedSearch(nextSearch);
    setSelectedIds([]);
    setResult(null);
    setPollError(null);
    recordedSearchId.current = null;

    try {
      const response = await searchApi.startSearch(nextSearch);
      setResult(response);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const retryStatusPolling = () => {
    if (!result?.searchId || !pollingStatuses.includes(result.meta.status)) {
      return;
    }

    setPollError(null);
    setPollRevision((current) => current + 1);
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

    if (!visibleIds.length) {
      setSelectedIds([]);
      return;
    }

    const allVisibleSelected = visibleIds.every((id) => selectedIdSet.has(id));
    setSelectedIds(allVisibleSelected ? [] : visibleIds);
  };

  const handleCopyRow = async (lead: Lead) => {
    const value = [
      lead.name,
      lead.mobile,
      lead.email,
      lead.website || lead.listingUrl || '',
      lead.address,
      lead.source,
    ]
      .map(toCsvField)
      .join(',');

    await navigator.clipboard.writeText(value);
    toast.success('Lead copied as CSV');
  };

  return (
    <>
      <div className="relative min-h-screen overflow-hidden bg-slate-50 text-slate-950">
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
              to="/history"
            >
              <Clock3 className="h-4 w-4" />
              <span className="hidden sm:inline">History</span>
            </Link>

            <SessionAction auth={auth} />
          </nav>
        </header>

        <section className="relative mx-auto flex max-w-7xl justify-center px-4 pb-8 pt-3 md:px-8">
          <motion.div
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-[1280px] rounded-[2rem] border border-white/70 bg-white/90 p-4 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-5"
            initial={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.45, delay: 0.08 }}
          >
            <div className="mb-5 flex items-start justify-between gap-4 px-1 pt-1">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.22em] text-blue-700">
                  New search
                </p>
                <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">
                  Build your lead list
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Choose GMB, LinkedIn, or free AI mode, then enter a business type, location, and lead count.
                </p>
              </div>

              <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-700 sm:flex">
                {activeSourceMode === 'linkedin' ? (
                  <BriefcaseBusiness className="h-6 w-6" />
                ) : activeSourceMode === 'ai' ? (
                  <Sparkles className="h-6 w-6" />
                ) : (
                  <MapPin className="h-6 w-6" />
                )}
              </div>
            </div>

            <SearchForm
              loading={loading}
              onChange={setSearch}
              onSourceModeChange={handleSourceModeChange}
              onSubmit={() => handleSearch()}
              value={search}
            />
          </motion.div>
        </section>

        <main className="relative mx-auto flex max-w-7xl flex-col gap-6 px-4 pb-28 md:px-8">
          {result ? (
            <ResultsSummary
              location={
                result.meta.locationLabel ||
                (submittedSearch ? formatLocationLabel(submittedSearch.location) : '')
              }
              companyType={submittedSearch?.companyType || search.companyType}
              found={result.meta.progress.foundCount ?? summary.total}
              requested={result.meta.progress.requestedCount ?? search.count}
              missingEmail={summary.missingEmail}
              missingPhone={summary.missingPhone}
              duplicatesRemoved={result.meta.progress.duplicatesRemoved ?? 0}
            />
          ) : (
            <section className="grid gap-4 md:grid-cols-3">
              <div className="rounded-[1.75rem] border border-slate-200 bg-white/90 p-5 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur">
                <p className="text-sm font-bold text-slate-950">Start with a location</p>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Search by US time zone or city/state to cover the right lead pool.
                </p>
              </div>

              <div className="rounded-[1.75rem] border border-slate-200 bg-white/90 p-5 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur">
                <p className="text-sm font-bold text-slate-950">Filter by contact quality</p>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Narrow results to leads with emails, phone numbers, or websites.
                </p>
              </div>

              <div className="rounded-[1.75rem] border border-slate-200 bg-white/90 p-5 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur">
                <p className="text-sm font-bold text-slate-950">Export only what matters</p>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Select specific rows or export every visible lead.
                </p>
              </div>
            </section>
          )}

          {result ? (
            <section
              className={`rounded-[1.75rem] border p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] ${
                result.meta.status === 'failed'
                  ? 'border-red-200 bg-red-50/90'
                  : linkedinDiscoveryBlocked
                    ? 'border-amber-200 bg-amber-50/90'
                  : result.meta.status === 'complete'
                    ? 'border-emerald-200 bg-emerald-50/70'
                    : 'border-blue-200 bg-white/90'
              }`}
            >
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-4">
                  <div
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${
                      result.meta.status === 'failed'
                        ? 'bg-red-100 text-red-700'
                        : linkedinDiscoveryBlocked
                          ? 'bg-amber-100 text-amber-700'
                        : result.meta.status === 'complete'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {isWaiting ? (
                      <LoaderCircle className="h-6 w-6 animate-spin" />
                    ) : linkedinDiscoveryBlocked ? (
                      <AlertTriangle className="h-6 w-6" />
                    ) : result.meta.status === 'complete' ? (
                      <CheckCircle2 className="h-6 w-6" />
                    ) : (
                      <Search className="h-6 w-6" />
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-500">
                      Search status
                    </p>
                    <h2 className="mt-2 text-xl font-black tracking-[-0.03em] text-slate-950">
                      {statusTitle}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-slate-600">{statusDescription}</p>
                    <p className="mt-2 text-sm font-medium text-slate-800">
                      Query: {result.meta.query}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[420px]">
                  <div className="rounded-2xl bg-white/80 p-3">
                    <p className="text-xs font-semibold text-slate-500">Found</p>
                    <p className="mt-1 text-xl font-black text-slate-950">
                      {result.meta.progress.foundCount}
                    </p>
                  </div>

                  <div className="rounded-2xl bg-white/80 p-3">
                    <p className="text-xs font-semibold text-slate-500">Requested</p>
                    <p className="mt-1 text-xl font-black text-slate-950">
                      {result.meta.progress.requestedCount}
                    </p>
                  </div>

                  <div className="rounded-2xl bg-white/80 p-3">
                    <p className="text-xs font-semibold text-slate-500">Visible</p>
                    <p className="mt-1 text-xl font-black text-slate-950">{visibleLeads.length}</p>
                  </div>

                  <div className="rounded-2xl bg-white/80 p-3">
                    <p className="text-xs font-semibold text-slate-500">Selected</p>
                    <p className="mt-1 text-xl font-black text-slate-950">{selectedIds.length}</p>
                  </div>
                  </div>
                </div>

                {activeSourceMode === 'linkedin' ? (
                  <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)]">
                    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/75 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
                          Public contact coverage
                        </p>
                        <p className="mt-1 text-sm leading-5 text-slate-600">
                          Validated emails or phone numbers found in public web results. Private or
                          Premium LinkedIn data is not accessed.
                        </p>
                      </div>
                      <p className="shrink-0 text-lg font-black text-slate-950">
                        {publicContactsFound}{' '}
                        <span className="text-sm font-semibold text-slate-500">
                          / {result.meta.progress.foundCount}
                        </span>
                      </p>
                    </div>
                    {publicQueriesAttempted || publicProvidersChecked ? (
                      <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
                          Public search coverage
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {publicQueriesAttempted ?? 0} query paths
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-600">
                          Checked across {publicProvidersChecked ?? 0} public search sources.
                        </p>
                      </div>
                    ) : null}
                    <div className="rounded-2xl border border-slate-200 bg-white/75 p-4 md:col-span-2">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
                            Match intelligence
                          </p>
                          <p className="mt-1 text-sm leading-5 text-slate-600">
                            Transparent ranking from public category, role, location, and source
                            signals. This is not private LinkedIn or Premium data.
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                          Public signals
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-3">
                        <div className="rounded-xl bg-slate-50 px-3 py-2">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                            High-fit score
                          </p>
                          <p className="mt-1 text-lg font-black text-slate-950">
                            {linkedinQuality.highFit}
                          </p>
                        </div>
                        <div className="rounded-xl bg-slate-50 px-3 py-2">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                            Cross-source
                          </p>
                          <p className="mt-1 text-lg font-black text-slate-950">
                            {linkedinQuality.corroborated}
                          </p>
                        </div>
                        <div className="rounded-xl bg-slate-50 px-3 py-2">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                            Role signals
                          </p>
                          <p className="mt-1 text-lg font-black text-slate-950">
                            {linkedinQuality.roleSignals}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeSourceMode === 'ai' ? (
                  <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
                          Free AI mode coverage
                        </p>
                        <p className="mt-1 text-sm leading-5 text-slate-600">
                          Public LinkedIn discovery and public website checks are merged and deduplicated. Commercial databases are audited but never called.
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-blue-700 shadow-sm">
                        No paid sources
                      </span>
                    </div>

                    {aiProviderCoverage.length ? (
                      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {aiProviderCoverage.map((provider) => {
                          const statusLabel =
                            provider.status === 'not_configured'
                              ? 'Not used'
                              : provider.status === 'returned'
                                ? `${provider.leadCount} leads`
                                : provider.status === 'failed'
                                  ? 'Unavailable'
                                  : 'Ready';
                          const statusClass =
                            provider.status === 'returned'
                              ? 'text-emerald-700'
                              : provider.status === 'failed'
                                ? 'text-amber-700'
                                : 'text-slate-500';

                          return (
                            <div
                              className="rounded-xl border border-white/80 bg-white/80 p-3"
                              key={provider.providerId}
                              title={provider.message}
                            >
                              <p className="truncate text-sm font-bold text-slate-900">
                                {provider.providerName}
                              </p>
                              <p className={`mt-1 text-xs font-semibold ${statusClass}`}>
                                {statusLabel}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    <p className="mt-3 text-xs leading-5 text-slate-500">
                      {result.meta.progress.aiAssistance === 'enabled'
                        ? 'AI query assistance enabled.'
                        : 'AI query assistance is off so this mode stays free. Matching uses local category and role intelligence.'}
                    </p>
                  </div>
                ) : null}

              {isWaiting ? (
                <div className="mt-5">
                  <div className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
                    <span>Progress</span>
                    <span>{progressPercent}%</span>
                  </div>

                  <div className="h-2 overflow-hidden rounded-full bg-white">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all duration-500"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              ) : null}

              {pollError ? (
                <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50/90 p-4 text-sm text-red-950 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-bold">Status update paused</p>
                    <p className="mt-1 leading-5 text-red-800/80">{pollError}</p>
                  </div>
                  <button
                    className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-red-700 px-4 text-sm font-bold text-white transition hover:bg-red-800"
                    onClick={retryStatusPolling}
                    type="button"
                  >
                    <LoaderCircle className="h-4 w-4" />
                    Retry status check
                  </button>
                </div>
              ) : null}

              {displayedProviderWarnings.length ? (
                <div className="mt-5 rounded-2xl border border-amber-200 bg-white/80 p-4 text-sm text-amber-950">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                    <div>
                      <p className="font-bold">
                        {linkedinDiscoveryBlocked
                          ? 'Provider access blocked'
                          : activeSourceMode === 'ai'
                            ? 'Public source notices'
                            : 'Provider notices'}
                      </p>
                      <ul className="mt-2 space-y-1.5 leading-5 text-amber-900/80">
                        {displayedProviderWarnings.map((warning) => (
                          <li key={`${warning.providerId}-${warning.message}`}>
                            <span className="font-semibold">{warning.providerName}:</span>{' '}
                            {warning.message}
                          </li>
                        ))}
                      </ul>
                      {result.meta.status === 'complete' && result.leads.length === 0 ? (
                        <button
                          className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white transition hover:bg-slate-700"
                          onClick={() => void handleSearch(submittedSearch ?? undefined)}
                          type="button"
                        >
                          <Search className="h-4 w-4" />
                          {activeSourceMode === 'ai' ? 'Try free search again' : 'Try public search again'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}

              {canRetryEmptyLinkedInSearch && !displayedProviderWarnings.length ? (
                <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-blue-200 bg-blue-50/80 p-4 text-sm text-blue-950 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-bold">No public profiles returned</p>
                    <p className="mt-1 leading-5 text-blue-900/80">
                      Public search results can change. Try the same search again or adjust the category.
                    </p>
                  </div>
                  <button
                    className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-700 px-4 text-sm font-bold text-white transition hover:bg-blue-800"
                    onClick={() => void handleSearch(submittedSearch ?? undefined)}
                    type="button"
                  >
                    <Search className="h-4 w-4" />
                    Try public search again
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          {loading ? (
            <section className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
              <div className="space-y-4">
                <div className="h-64 animate-pulse rounded-[1.75rem] border border-slate-200 bg-white/80" />
                <div className="h-40 animate-pulse rounded-[1.75rem] border border-slate-200 bg-white/80" />
              </div>

              <div className="space-y-4">
                {[0, 1, 2, 3].map((item) => (
                  <div
                    className="h-24 animate-pulse rounded-[1.75rem] border border-slate-200 bg-white/80"
                    key={item}
                  />
                ))}
              </div>
            </section>
          ) : isWaiting ? (
            <section className="rounded-[2rem] border border-slate-200 bg-white/90 p-8 text-center shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                <LoaderCircle className="h-7 w-7 animate-spin" />
              </div>

              <h2 className="mt-5 text-2xl font-black tracking-[-0.04em] text-slate-950">
                Finding your leads
              </h2>

              <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-600">
                Results will appear here when the search finishes. You can keep this page open while
                the job runs.
              </p>
            </section>
          ) : result?.meta.status === 'failed' ? (
            <section className="rounded-[2rem] border border-red-200 bg-red-50 p-8 text-center shadow-[0_24px_80px_rgba(127,29,29,0.08)]">
              <h2 className="text-2xl font-black tracking-[-0.04em] text-red-950">
                Search could not be completed
              </h2>

              <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-red-700">
                Try a broader company type, a different time zone, or a smaller lead count.
              </p>
            </section>
          ) : result ? (
            <section className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
              <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
                <FiltersPanel
                  filters={filters}
                  onChange={setFilters}
                  sourceMode={activeSourceMode}
                />

                <div className="overflow-hidden rounded-[1.75rem] border border-slate-900 bg-slate-950 p-5 text-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
                  <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-blue-200">
                    <Zap className="h-3.5 w-3.5" />
                    Export queue
                  </p>

                  <p className="mt-5 text-4xl font-black tracking-[-0.05em]">
                    {selectedIds.length || visibleLeads.length}
                  </p>

                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    {selectedIds.length
                      ? 'Selected rows are ready for download.'
                      : 'Visible leads are export-ready by default.'}
                  </p>

                  <div className="mt-5 grid gap-2 text-sm">
                    <div className="flex items-center justify-between rounded-2xl bg-white/10 px-3 py-2">
                      <span className="text-slate-300">With email</span>
                      <span className="font-bold text-white">{summary.withEmail}</span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-white/10 px-3 py-2">
                      <span className="text-slate-300">With phone</span>
                      <span className="font-bold text-white">{summary.withPhone}</span>
                    </div>

                    <div className="flex items-center justify-between rounded-2xl bg-white/10 px-3 py-2">
                      <span className="text-slate-300">With website</span>
                      <span className="font-bold text-white">{summary.withWebsite}</span>
                    </div>
                  </div>
                </div>
              </aside>

              <div className="rounded-[2rem] border border-slate-200 bg-white/90 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur sm:p-5">
                <div className="mb-5 flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
                      <Filter className="h-3.5 w-3.5" />
                      Results
                    </p>

                    <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-slate-950">
                      {visibleLeads.length} visible leads
                    </h2>
                  </div>

                  <p className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600">
                    {selectedIds.length
                      ? `${selectedIds.length} selected`
                      : 'No rows selected'}
                  </p>
                </div>

                <ResultsTable
                  emptyStateMessage={emptyStateMessage}
                  leads={deferredLeads}
                  onCopyRow={(lead) => void handleCopyRow(lead)}
                  onSelectAll={toggleSelectAll}
                  onToggleSelect={toggleSelected}
                  selectedIds={selectedIds}
                />
              </div>
            </section>
          ) : (
            <section className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 p-10 text-center backdrop-blur">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
                <Search className="h-7 w-7" />
              </div>

              <h2 className="mt-5 text-2xl font-black tracking-[-0.04em] text-slate-950">
                Run a search to see results
              </h2>

              <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-500">
                Your leads, filters, contact coverage, and export tools will appear here.
              </p>
            </section>
          )}
        </main>
      </div>

      {result?.meta.status === 'complete' ? (
        <div className="sticky bottom-4 z-40 mx-auto flex w-[min(100%-2rem,1120px)] items-center justify-between gap-4 rounded-[1.5rem] border border-slate-200 bg-white/95 px-5 py-4 shadow-[0_24px_80px_rgba(15,23,42,0.16)] backdrop-blur-xl">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
              Ready to export
            </p>
            <p className="mt-1 text-sm font-medium text-slate-700">
              {selectedIds.length
                ? `${selectedIds.length} selected rows`
                : `${visibleLeads.length} visible leads`}
            </p>
          </div>

          <button
            className="inline-flex h-12 items-center gap-2 rounded-2xl bg-emerald-600 px-5 text-sm font-bold text-white shadow-lg shadow-emerald-600/20 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
            disabled={!exportableLeads.length}
            onClick={() => setShowExport(true)}
            type="button"
          >
            <Download className="h-4 w-4" />
            Download Excel
          </button>
        </div>
      ) : null}

      <ExportModal
        leads={exportableLeads}
        onClose={() => setShowExport(false)}
        open={showExport}
      />
    </>
  );
}
