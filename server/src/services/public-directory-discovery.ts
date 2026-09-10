import type { Lead } from '../types/lead';
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
  returned: number;
  failed: number;
  messages: string[];
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

  return buildDiscoverySeeds(location)
    .map(normalizeLocationLabel)
    .filter(Boolean)
    .slice(0, maxLocations);
};

const getCategoryQuery = (request: SearchRequest, locationLabel: string) =>
  `${request.companyType.trim()} in ${locationLabel}`;

const getProviderCoverageId = (provider: LeadProvider) =>
  `${provider.id}-public-directory`;

const getCoverageMessage = (run: ProviderRun) => {
  const locationLabel = run.attempted === 1 ? 'location' : 'locations';
  const resultLabel = run.returned === 1 ? 'candidate' : 'candidates';

  return `Checked ${run.attempted} public directory ${locationLabel}; ${run.returned} ${resultLabel} returned${run.failed ? `, ${run.failed} quer${run.failed === 1 ? 'y' : 'ies'} unavailable` : ''}.`;
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
    const returnedLeads: Lead[] = [];
    let nextTaskIndex = 0;

    for (const provider of providers) {
      runs.set(provider.id, {
        provider,
        attempted: 0,
        returned: 0,
        failed: 0,
        messages: [],
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
          run.failed += 1;
          run.messages.push('Directory discovery window exhausted before this query started.');
          continue;
        }

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

          returnedLeads.push(...leads);
          run.returned += leads.length;
        } catch (error) {
          run.failed += 1;
          const message = error instanceof Error
            ? error.message
            : `${task.provider.name} public directory query failed.`;
          run.messages.push(message);
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrent, Math.max(1, tasks.length)) },
        () => worker(),
      ),
    );

    const coverage = [...runs.values()].map((run) => {
      const failed = run.failed > 0;
      const returned = run.attempted > 0;
      const status: ProviderCoverage['status'] = failed && returned
        ? 'partial'
        : failed
          ? 'failed'
          : returned
            ? 'returned'
            : 'not_configured';

      return {
        providerId: getProviderCoverageId(run.provider),
        providerName: `${run.provider.name}, Public Directory`,
        status,
        leadCount: run.returned,
        message: run.attempted
          ? getCoverageMessage(run)
          : 'No public directory query was started inside the bounded discovery window.',
      } satisfies ProviderCoverage;
    });

    for (const run of runs.values()) {
      if (!run.failed) continue;

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
      warnings,
      coverage,
    };
  };
};

export const discoverUsLeadsFromPublicDirectories = createPublicDirectoryDiscovery();
