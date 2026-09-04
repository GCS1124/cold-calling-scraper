import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  Filter,
  Info,
  LoaderCircle,
  MapPin,
  Search,
  Sparkles,
  Zap,
  BriefcaseBusiness,
  RefreshCw,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import { SessionAction } from '../components/auth/session-action';
import { FiltersPanel } from '../components/results/filters-panel';
import { LinkedInQualityPanel } from '../components/results/linkedin-quality-panel';
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
import {
  getLinkedInRankingScore,
  isContactReadyLinkedInLead,
  isEvidenceBackedLinkedInLead,
  isHighFitLinkedInLead,
  type LinkedInSortMode,
} from '../utils/linkedin-quality';
import { sourceModeLabelsByCode } from '../data/search-options';
import type { Lead, SearchDraft, SearchRequest, SearchResponse } from '../types/lead';

type HomePageProps = {
  searchApi: SearchApi;
};

const ExportModal = lazy(async () => {
  const module = await import('../components/export/export-modal');

  return { default: module.ExportModal };
});

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
  const [reverifying, setReverifying] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [submittedSearch, setSubmittedSearch] = useState<SearchRequest | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const [filters, setFilters] = useState({
    hasEmail: false,
    hasPhone: true,
    hasWebsite: false,
    highFitOnly: false,
    crossSourceOnly: false,
    contactReadyOnly: false,
    evidenceBackedOnly: false,
  });
  const [linkedinSortMode, setLinkedinSortMode] = useState<LinkedInSortMode>('best-match');

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
      hasPhone: true,
      hasWebsite: false,
      highFitOnly: false,
      crossSourceOnly: false,
      contactReadyOnly: false,
      evidenceBackedOnly: false,
    });
    setLinkedinSortMode('best-match');

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
        // Phone qualification is a product requirement, not an optional view filter.
        if (!lead.hasPhone) return false;
        if (filters.hasWebsite && !lead.hasWebsite) return false;
        if (
          activeSourceMode === 'linkedin' &&
          filters.highFitOnly &&
          !isHighFitLinkedInLead(lead)
        ) {
          return false;
        }
        if (
          activeSourceMode === 'linkedin' &&
          filters.crossSourceOnly &&
          (lead.matchSignals?.publicSources ?? 0) < 2
        ) {
          return false;
        }
        if (
          activeSourceMode === 'linkedin' &&
          filters.contactReadyOnly &&
          !isContactReadyLinkedInLead(lead)
        ) {
          return false;
        }
        if (
          activeSourceMode === 'linkedin' &&
          filters.evidenceBackedOnly &&
          !isEvidenceBackedLinkedInLead(lead)
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        if (activeSourceMode === 'linkedin') {
          return (
            getLinkedInRankingScore(right, linkedinSortMode) -
              getLinkedInRankingScore(left, linkedinSortMode) ||
            right.confidence - left.confidence ||
            left.name.localeCompare(right.name)
          );
        }

        return right.confidence - left.confidence;
      });
  }, [
    activeSourceMode,
    filters.crossSourceOnly,
    filters.contactReadyOnly,
    filters.evidenceBackedOnly,
    filters.hasEmail,
    filters.hasWebsite,
    filters.highFitOnly,
    linkedinSortMode,
    result?.leads,
  ]);

  const deferredVisibleLeads = useDeferredValue(visibleLeads);
  // Small result sets should never show a stale empty table while the header
  // already reports the updated count. Keep deferral for larger tables only.
  const tableLeads = visibleLeads.length <= 100 ? visibleLeads : deferredVisibleLeads;

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const exportableLeads = useMemo(() => {
    if (!selectedIds.length) return visibleLeads;
    return visibleLeads.filter((lead) => selectedIdSet.has(lead.id));
  }, [selectedIdSet, selectedIds.length, visibleLeads]);

  const isWaiting = Boolean(result && pollingStatuses.includes(result.meta.status));
  const isCancelled = result?.meta.status === 'cancelled';
  const phoneExcludedCount = result?.meta.progress.phoneExcludedCount ?? 0;
  const phoneGateFailure = Boolean(
    result &&
      result.meta.status === 'failed' &&
      result.meta.progress.foundCount === 0 &&
      phoneExcludedCount > 0,
  );

  const summary = useMemo(() => {
    const allLeads = result?.leads ?? [];

    return {
      total: visibleLeads.length,
      withEmail: visibleLeads.filter((lead) => lead.hasEmail).length,
      withPhone: visibleLeads.filter((lead) => lead.hasPhone).length,
      withWebsite: visibleLeads.filter((lead) => lead.hasWebsite).length,
      publicContacts: visibleLeads.filter((lead) => lead.hasEmail || lead.hasPhone).length,
      missingEmail: allLeads.filter((lead) => !lead.hasEmail).length,
      missingPhone: Math.max(allLeads.filter((lead) => !lead.hasPhone).length, phoneExcludedCount),
    };
  }, [phoneExcludedCount, result?.leads, visibleLeads]);

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
  const publicQueryFamilies = result?.meta.progress.publicQueryFamilies ?? [];
  const publicQueryFamilyCounts = result?.meta.progress.publicQueryFamilyCounts ?? {};
  const aiProviderCoverage = result?.meta.progress.providerCoverage ?? [];
  const displayedProviderWarnings =
    activeSourceMode === 'ai'
      ? (result?.meta.providerWarnings ?? []).filter(
          (warning) => warning.providerId !== 'ai-mode-policy',
        )
      : result?.meta.providerWarnings ?? [];
  const phoneRequirementWarning = Boolean(
    result?.meta.providerWarnings.some((warning) => warning.providerId === 'phone-required'),
  );
  const providerNoticesAreInformational =
    displayedProviderWarnings.length > 0 &&
    displayedProviderWarnings.every((warning) => warning.severity === 'info');
  const linkedinDiscoveryBlocked = Boolean(
    result &&
      activeSourceMode === 'linkedin' &&
      (result.meta.status === 'complete' || result.meta.status === 'failed') &&
      result.leads.length === 0 &&
      result.meta.providerWarnings.some(
        (warning) =>
          warning.providerId === 'linkedin-search' &&
          /blocked|rate-limited/i.test(warning.message),
      ),
  );
  const providerFailureNotice = Boolean(
    result?.meta.providerWarnings.some(
      (warning) =>
        warning.severity === 'error' ||
        /failed|blocked|rate-limited|timed out|timeout/i.test(warning.message),
    ),
  );
  const resultsExhausted =
    result !== null &&
    result.meta.status === 'complete' &&
    result.meta.progress.foundCount < result.meta.progress.requestedCount;
  const canRetryEmptyLinkedInSearch = Boolean(
    result &&
      activeSourceMode === 'linkedin' &&
      (result.meta.status === 'complete' || result.meta.status === 'failed') &&
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
        : result.meta.status === 'cancelled'
          ? 'Search cancelled'
        : phoneGateFailure
          ? 'No eligible leads after phone validation'
        : linkedinDiscoveryBlocked
              ? 'LinkedIn discovery blocked'
              : result.meta.status === 'failed'
                ? 'Search failed'
                : providerFailureNotice
                  ? 'Search finished with provider limits'
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
              : result.meta.status === 'cancelled'
                ? 'The partial research snapshot is preserved. Resume when you want to continue public-source discovery.'
              : linkedinDiscoveryBlocked
                      ? 'Free public-search providers temporarily blocked this request. No unverified or fabricated leads were added.'
                      : phoneGateFailure
                        ? `${phoneExcludedCount} public candidate${phoneExcludedCount === 1 ? '' : 's'} were discovered, but none exposed a validated public phone/mobile number. Those profiles were not accepted as leads.`
                      : result.meta.status === 'failed'
                        ? 'The search could not be completed. Adjust the query and try again.'
                        : providerFailureNotice
                          ? 'Some public providers were unavailable. Only verified results were retained; review the provider notices before exporting.'
                        : phoneRequirementWarning
                          ? 'Only leads with a validated publicly listed phone/mobile number were retained. Private or Premium contact data is not accessed.'
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
      ? linkedinDiscoveryBlocked
        ? 'LinkedIn discovery was blocked by the free public-search providers. Try again later or switch location.'
        : result.meta.status === 'failed'
          ? phoneGateFailure
            ? `${phoneExcludedCount} public candidates were found, but none had a validated publicly listed phone/mobile number. Broaden the category or location and try again.`
            : 'Search could not be completed because no usable leads passed the public-contact validation gate.'
          : result.meta.status === 'complete'
            ? phoneRequirementWarning
              ? 'No leads with a validated publicly listed phone/mobile number were found. Broaden the category or location and try again.'
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
                      status: 'failed',
                      progress: {
                        ...current.meta.progress,
                        currentSource: 'Failed',
                      },
                      providerWarnings: [
                        ...current.meta.providerWarnings,
                        {
                          providerId: 'search-status',
                          providerName: 'Search status',
                          message:
                            'The durable search snapshot is no longer available. The search was not marked complete.',
                          severity: 'error',
                        },
                      ],
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

  const cancelCurrentSearch = async () => {
    if (!result?.searchId || !searchApi.cancelSearch) {
      return;
    }

    try {
      const response = await searchApi.cancelSearch(result.searchId);
      if (response) {
        setResult(response);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to cancel this search');
    }
  };

  const resumeCurrentSearch = async () => {
    if (!result?.searchId || !searchApi.resumeSearch) {
      return;
    }

    try {
      const response = await searchApi.resumeSearch(result.searchId);
      if (response) {
        setResult(response);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to resume this search');
    }
  };

  const reverifyCurrentSearch = async () => {
    if (!result?.searchId || !searchApi.reverifySearch) {
      return;
    }

    setReverifying(true);
    try {
      const response = await searchApi.reverifySearch(result.searchId);
      if (response) {
        setResult(response);
        toast.success('Public evidence and contact validation refreshed.');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to reverify this search');
    } finally {
      setReverifying(false);
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
    const visibleIds = visibleLeads.map((lead) => lead.id);

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
      lead.website,
      lead.listingUrl,
      lead.contactSourceUrl,
      lead.confidence,
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
              phoneExcludedCount={phoneExcludedCount}
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
                result.meta.status === 'failed' && !phoneGateFailure
                  ? 'border-red-200 bg-red-50/90'
                  : phoneGateFailure
                    ? 'border-amber-200 bg-amber-50/90'
                  : result.meta.status === 'cancelled'
                    ? 'border-slate-300 bg-slate-100/90'
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
                      result.meta.status === 'failed' && !phoneGateFailure
                        ? 'bg-red-100 text-red-700'
                        : phoneGateFailure
                          ? 'bg-amber-100 text-amber-700'
                        : result.meta.status === 'cancelled'
                          ? 'bg-slate-200 text-slate-700'
                        : linkedinDiscoveryBlocked
                          ? 'bg-amber-100 text-amber-700'
                        : result.meta.status === 'complete'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {isWaiting ? (
                      <LoaderCircle className="h-6 w-6 animate-spin" />
                    ) : linkedinDiscoveryBlocked || phoneGateFailure ? (
                      <AlertTriangle className="h-6 w-6" />
                    ) : result.meta.status === 'complete' ? (
                      <CheckCircle2 className="h-6 w-6" />
                    ) : result.meta.status === 'cancelled' ? (
                      <Clock3 className="h-6 w-6" />
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

                {isWaiting && searchApi.cancelSearch ? (
                  <button
                    className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                    onClick={() => void cancelCurrentSearch()}
                    type="button"
                  >
                    Stop search
                  </button>
                ) : isCancelled && searchApi.resumeSearch ? (
                  <button
                    className="inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-4 text-sm font-bold text-white transition hover:bg-slate-800"
                    onClick={() => void resumeCurrentSearch()}
                    type="button"
                  >
                    Resume search
                  </button>
                ) : result.meta.status === 'complete' && searchApi.reverifySearch ? (
                  <button
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={reverifying}
                    onClick={() => void reverifyCurrentSearch()}
                    type="button"
                  >
                    <RefreshCw className={`h-4 w-4 ${reverifying ? 'animate-spin' : ''}`} />
                    {reverifying ? 'Reverifying...' : 'Reverify public data'}
                  </button>
                ) : null}

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
                  <div>
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
                    <LinkedInQualityPanel
                      leads={result.leads}
                      publicContactsFound={publicContactsFound}
                      publicProvidersChecked={publicProvidersChecked}
                      publicQueryFamilies={publicQueryFamilies}
                      publicQueryFamilyCounts={publicQueryFamilyCounts}
                      publicQueriesAttempted={publicQueriesAttempted}
                    />
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
                          Public LinkedIn discovery, public website checks, and published social links are merged and deduplicated. Commercial databases are audited but never called.
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-blue-700 shadow-sm">
                        No paid lead databases
                      </span>
                    </div>

                    {aiProviderCoverage.length ? (
                      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {aiProviderCoverage.map((provider) => {
                          const statusLabel =
                              provider.status === 'not_configured'
                                ? 'Not used'
                                : provider.status === 'returned'
                                ? provider.providerId === 'gemini-query-assistance'
                                  ? 'Query wording returned'
                                  : `${provider.leadCount} discovered`
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

                    {phoneExcludedCount > 0 ? (
                      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-950">
                        <p className="font-bold">Eligibility gate</p>
                        <p className="mt-1 leading-5 text-amber-900/80">
                          {phoneExcludedCount} discovered candidate{phoneExcludedCount === 1 ? '' : 's'}
                          {' '}were excluded because AI mode requires a validated public phone/mobile number.
                        </p>
                      </div>
                    ) : null}

                    <p className="mt-3 text-xs leading-5 text-slate-500">
                      {result.meta.progress.aiAssistance === 'enabled'
                        ? 'Optional Gemini query assistance rewrote search wording only; public providers supplied the leads.'
                        : result.meta.progress.aiAssistance === 'failed'
                          ? 'Optional Gemini query assistance was unavailable; local public query expansion continued.'
                          : 'Gemini query assistance is disabled by default. Matching uses local category and role intelligence, and public providers supply the leads.'}
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
                <div
                  className={`mt-5 rounded-2xl border p-4 text-sm ${
                    providerNoticesAreInformational
                      ? 'border-blue-200 bg-blue-50/80 text-blue-950'
                      : 'border-amber-200 bg-white/80 text-amber-950'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {providerNoticesAreInformational ? (
                      <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                    )}
                    <div>
                      <p className="font-bold">
                        {linkedinDiscoveryBlocked
                          ? 'Provider access blocked'
                          : activeSourceMode === 'ai'
                            ? 'Public source notices'
                            : providerNoticesAreInformational
                              ? 'Provider notes'
                              : 'Provider notices'}
                      </p>
                      <ul
                        className={`mt-2 space-y-1.5 leading-5 ${
                          providerNoticesAreInformational ? 'text-blue-900/80' : 'text-amber-900/80'
                        }`}
                      >
                        {displayedProviderWarnings.map((warning) => (
                          <li key={`${warning.providerId}-${warning.message}`}>
                            <span className="font-semibold">{warning.providerName}:</span>{' '}
                            {warning.message}
                          </li>
                        ))}
                      </ul>
                      {(result.meta.status === 'complete' || result.meta.status === 'failed') &&
                      result.leads.length === 0 ? (
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
          ) : isWaiting && !result?.leads.length ? (
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

                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <h2 className="text-2xl font-black tracking-[-0.04em] text-slate-950">
                        {visibleLeads.length} visible leads
                      </h2>
                      {isWaiting ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          Live scan
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    {activeSourceMode === 'linkedin' ? (
                      <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600">
                        Rank by
                        <select
                          aria-label="Rank LinkedIn results"
                          className="bg-transparent text-xs font-bold text-slate-950 outline-none"
                          value={linkedinSortMode}
                          onChange={(event) =>
                            setLinkedinSortMode(event.target.value as LinkedInSortMode)
                          }
                        >
                          <option value="best-match">Best match</option>
                          <option value="contact-ready">Contact ready</option>
                          <option value="corroborated">Most corroborated</option>
                        </select>
                      </label>
                    ) : null}
                    <p className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600">
                      {selectedIds.length
                        ? `${selectedIds.length} selected`
                        : 'No rows selected'}
                    </p>
                  </div>
                </div>

                <ResultsTable
                  emptyStateMessage={emptyStateMessage}
                  leads={tableLeads}
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

      {showExport ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm">
              <div className="rounded-2xl bg-white px-5 py-4 text-sm font-semibold text-slate-700 shadow-xl">
                Preparing export...
              </div>
            </div>
          }
        >
          <ExportModal
            leads={exportableLeads}
            onClose={() => setShowExport(false)}
            open={showExport}
          />
        </Suspense>
      ) : null}
    </>
  );
}
