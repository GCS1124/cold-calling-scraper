import { createHash } from 'node:crypto';

import type { Lead, ReviewCandidate } from '../types/lead';
import type {
  ProviderCoverage,
  ProviderWarning,
  SearchRequest,
} from '../types/search';
import {
  deduplicateLeads,
} from './lead-deduplication';
import { buildDiscoverySeeds } from './discovery-seeds';
import { yellowPagesProvider } from '../providers/yellowpages';
import { yelpProvider } from '../providers/yelp';
import type { LeadProvider } from '../providers/provider';
import type { NormalizedUsLocation } from './us-location';
import { isPhoneQualifiedLead } from './phone-requirement';

/**
 * Public directory discovery is deliberately separate from the paid/provider
 * audit layer. These adapters only request public result pages and never try
 * to solve CAPTCHA, Cloudflare, login, or geo-block challenges.
 */
export const publicDirectoryProviders: readonly LeadProvider[] = [
  yelpProvider,
  yellowPagesProvider,
];

export type PublicDirectoryDiscoveryResult = {
  leads: Lead[];
  reviewCandidates: ReviewCandidate[];
  warnings: ProviderWarning[];
  coverage: ProviderCoverage[];
};

type PublicDirectoryDiscoveryDeps = {
  providers?: readonly LeadProvider[];
  maxConcurrent?: number;
};

type DirectoryTask = {
  provider: LeadProvider;
  locationLabel: string;
  query: string;
  request: SearchRequest;
};

type ProviderRun = {
  provider: LeadProvider;
  attempted: number;
  observed: number;
  accepted: number;
  review: number;
  failed: number;
  blocked: number;
  timedOut: number;
  deferred: number;
  messages: string[];
  observedLeads: Lead[];
  acceptedLeads: Lead[];
  reviewCandidates: ReviewCandidate[];
};

const defaultDiscoveryWindowMs = 12_000;
const perQueryTimeoutMs = 7_500;

const normalizeLocationLabel = (value: string) =>
  value.trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ');

const getDirectoryLocationLabels = (
  location: NormalizedUsLocation,
  requestedCount: number,
) => {
  if (location.mode === 'local') {
    return [normalizeLocationLabel(location.label || location.city)];
  }

  const maxLocations = Math.min(
    location.mode === 'timezone' ? 6 : 8,
    Math.max(4, Math.ceil(Math.max(50, requestedCount) / 100)),
  );

  const seeds = buildDiscoverySeeds(location)
    .map(normalizeLocationLabel)
    .filter(Boolean)
    .slice(0, maxLocations);

  // Spread the first bounded calls across both halves of a broad region. A
  // short provider window therefore samples more than adjacent metro areas
  // rather than repeatedly starving later locations.
  const midpoint = Math.ceil(seeds.length / 2);
  return Array.from({ length: seeds.length }, (_, index) => {
    const offset = Math.floor(index / 2);
    return seeds[index % 2 ? midpoint + offset : offset];
  }).filter((value): value is string => Boolean(value));
};

const getCategoryQuery = (request: SearchRequest, locationLabel: string) =>
  `${request.companyType.trim()} in ${locationLabel}`;

const getProviderCoverageId = (provider: LeadProvider) =>
  `${provider.id}-public-directory`;

const getCoverageMessage = (run: ProviderRun) => {
  const locationLabel = run.attempted === 1 ? 'location' : 'locations';
  const resultLabel = run.observed === 1 ? 'candidate' : 'candidates';
  const unavailable = run.blocked + run.timedOut + run.failed;

  return `Checked ${run.attempted} public directory ${locationLabel}; ${run.observed} ${resultLabel} observed, ${run.accepted} accepted${run.review ? `, ${run.review} retained for review` : ''}${unavailable ? `, ${unavailable} quer${unavailable === 1 ? 'y' : 'ies'} unavailable` : ''}${run.deferred ? `, ${run.deferred} deferred` : ''}.`;
};

const isBlockedFailure = (message: string) =>
  /captcha|cloudflare|access challenge|access denied|forbidden|blocked|human verification/i.test(message);

const isTimeoutFailure = (message: string) => /deadline|timed out|timeout/i.test(message);

const isSafeTransientFailure = (message: string) =>
  /(?:econnreset|econnrefused|network|socket|temporar(?:y|ily)|http 5\d\d|status 5\d\d)/i.test(message);

const directoryReviewCandidate = (
  lead: Lead,
  provider: LeadProvider,
): ReviewCandidate => {
  const sourceUrls = [lead.listingUrl, lead.contactSourceUrl, lead.website]
    .filter((value): value is string => Boolean(value?.trim()));
  const reportedPhone = lead.mobile?.trim() || undefined;
  const reason = reportedPhone ? 'invalid_public_phone' : 'missing_public_phone';
  const stablePart = sourceUrls[0] || `${lead.name}|${lead.city}|${reportedPhone ?? ''}`;

  return {
    id: `${provider.id}-review-${createHash('sha1').update(stablePart).digest('hex').slice(0, 20)}`,
    providerId: getProviderCoverageId(provider),
    providerName: `${provider.name}, Public Directory`,
    reason,
    reasonDetail: reportedPhone
      ? 'The publicly reported directory phone did not validate as a US phone number.'
      : 'The public directory listing did not expose a valid US phone number.',
    name: lead.name,
    organizationName: lead.organizationName ?? lead.name,
    location: lead.address || lead.city,
    website: lead.website || undefined,
    profileUrl: lead.listingUrl || undefined,
    reportedPhone,
    reportedEmail: lead.email || undefined,
    sourceUrls,
    evidence: `Public ${provider.name} directory candidate retained outside the exportable lead pool.`,
    discoveredAt: lead.scrapedAt || new Date().toISOString(),
  };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string) => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const addWarningOnce = (warnings: ProviderWarning[], warning: ProviderWarning) => {
  if (warnings.some((item) => item.providerId === warning.providerId && item.message === warning.message)) {
    return;
  }

  warnings.push(warning);
};

export const createPublicDirectoryDiscovery = (
  deps: PublicDirectoryDiscoveryDeps = {},
) => {
  const providers = deps.providers ?? publicDirectoryProviders;
  const maxConcurrent = Math.max(1, Math.min(6, Math.round(deps.maxConcurrent ?? 4)));

  return async ({
    request,
    location,
    deadlineMs = Date.now() + defaultDiscoveryWindowMs,
  }: {
    request: SearchRequest;
    location: NormalizedUsLocation;
    deadlineMs?: number;
  }): Promise<PublicDirectoryDiscoveryResult> => {
    const locationLabels = getDirectoryLocationLabels(location, request.count);
    const perLocationCount = Math.min(
      50,
      Math.max(20, Math.ceil(Math.max(50, request.count) / Math.max(1, locationLabels.length))),
    );
    const tasks: DirectoryTask[] = locationLabels.flatMap((locationLabel) =>
      providers.map((provider) => ({
        provider,
        locationLabel,
        query: getCategoryQuery(request, locationLabel),
        request: {
          ...request,
          city: locationLabel,
          count: perLocationCount,
          phoneRequired: true,
        },
      })),
    );
    const runs = new Map<string, ProviderRun>();
    const warnings: ProviderWarning[] = [];
    let nextTaskIndex = 0;

    for (const provider of providers) {
      runs.set(provider.id, {
        provider,
        attempted: 0,
        observed: 0,
        accepted: 0,
        review: 0,
        failed: 0,
        blocked: 0,
        timedOut: 0,
        deferred: 0,
        messages: [],
        observedLeads: [],
        acceptedLeads: [],
        reviewCandidates: [],
      });
    }

    const worker = async () => {
      while (true) {
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;
        const task = tasks[taskIndex];
        if (!task) return;

        const run = runs.get(task.provider.id);
        if (!run) return;

        if (Date.now() >= deadlineMs) {
          run.deferred += 1;
          run.messages.push('Directory discovery window exhausted before this query started.');
          continue;
        }

        let completed = false;
        for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
          run.attempted += 1;
          const remainingMs = Math.max(1, deadlineMs - Date.now());

          try {
            const leads = await withTimeout(
              task.provider.fetchLeads({
                rawQuery: request.companyType,
                query: task.query,
                request: task.request,
                deadlineMs,
                maxLeadCount: perLocationCount,
                maxSearchQueries: 1,
                maxConcurrentSearches: 1,
              }),
              Math.min(perQueryTimeoutMs, remainingMs),
              `${task.provider.name} public directory query timed out for ${task.locationLabel}.`,
            );

            run.observedLeads.push(...(Array.isArray(leads) ? leads : []));
            completed = true;
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : `${task.provider.name} public directory query failed.`;
            const mayRetry = attempt === 0 &&
              isSafeTransientFailure(message) &&
              Date.now() + 500 < deadlineMs;
            if (mayRetry) {
              run.messages.push(`${message} Retrying once inside the bounded provider window.`);
              continue;
            }

            if (isBlockedFailure(message)) run.blocked += 1;
            else if (isTimeoutFailure(message)) run.timedOut += 1;
            else run.failed += 1;
            run.messages.push(message);
          }
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrent, Math.max(1, tasks.length)) },
        () => worker(),
      ),
    );

    // Keep coverage as provider observations across concrete location seeds,
    // while the lead pool itself is deduplicated before it is returned. This
    // preserves useful broad-location coverage telemetry without exporting
    // the same business repeatedly.
    const returnedLeads = [...runs.values()].flatMap((run) => {
      const uniqueObserved = deduplicateLeads(run.observedLeads);
      const accepted = uniqueObserved.filter(isPhoneQualifiedLead);
      const reviews = uniqueObserved
        .filter((lead) => !isPhoneQualifiedLead(lead))
        .map((lead) => directoryReviewCandidate(lead, run.provider));
      run.observed = uniqueObserved.length;
      run.acceptedLeads = accepted;
      run.accepted = accepted.length;
      run.reviewCandidates = [...new Map(reviews.map((candidate) => [candidate.id, candidate])).values()];
      run.review = run.reviewCandidates.length;
      return accepted;
    });

    const coverage = [...runs.values()].map((run) => {
      const failures = run.blocked + run.timedOut + run.failed;
      const outcome: NonNullable<ProviderCoverage['outcome']> = run.blocked
        ? 'blocked'
        : run.timedOut
          ? 'timed_out'
          : run.failed
            ? 'failed'
            : run.deferred
              ? 'deferred'
              : run.accepted
                ? 'returned'
                : run.review
                  ? 'filtered'
                  : run.attempted
                    ? 'empty'
                    : 'not_started';
      const phase: NonNullable<ProviderCoverage['phase']> =
        outcome === 'blocked' || outcome === 'timed_out' || outcome === 'failed'
          ? 'degraded'
          : outcome === 'deferred' || outcome === 'not_started'
            ? 'queued'
            : 'completed';
      const status: ProviderCoverage['status'] =
        phase === 'degraded'
          ? 'partial'
          : phase === 'queued'
            ? 'configured'
            : 'returned';

      return {
        providerId: getProviderCoverageId(run.provider),
        providerName: `${run.provider.name}, Public Directory`,
        status,
        leadCount: run.accepted,
        phase,
        outcome,
        attemptedCount: run.attempted,
        observedCount: run.observed,
        acceptedCount: run.accepted,
        reviewCount: run.review,
        deferredCount: run.deferred,
        updatedAt: new Date().toISOString(),
        message: run.attempted
          ? getCoverageMessage(run)
          : run.deferred
            ? 'No public directory query was started inside the bounded discovery window; work was deferred.'
            : 'No public directory query was started inside the bounded discovery window.',
      } satisfies ProviderCoverage;
    });

    for (const run of runs.values()) {
      if (!run.failed && !run.blocked && !run.timedOut) continue;

      const message = run.messages[0] ?? `${run.provider.name} public directory discovery failed.`;
      addWarningOnce(warnings, {
        providerId: getProviderCoverageId(run.provider),
        providerName: `${run.provider.name}, Public Directory`,
        message: `${message} Other public sources were preserved; no access challenge was bypassed.`,
        severity: 'info',
      });
    }

    return {
      leads: deduplicateLeads(returnedLeads),
      reviewCandidates: [...new Map(
        [...runs.values()]
          .flatMap((run) => run.reviewCandidates)
          .map((candidate) => [candidate.id, candidate]),
      ).values()],
      warnings,
      coverage,
    };
  };
};

export const discoverUsLeadsFromPublicDirectories = createPublicDirectoryDiscovery();
