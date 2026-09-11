export type LeadFinderMode = 'gmb' | 'linkedin' | 'ai';
export type ResearchDepth = 'quick' | 'verified' | 'pro';
export type SearchStatus =
  | 'queued'
  | 'discovering'
  | 'enriching'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type SearchLocation =
  | { mode: 'timezone'; timeZone: 'EST' | 'CST' | 'MST' | 'PST' }
  | { mode: 'cityState'; city: string; stateCode: string };

export type SearchFilters = {
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasWebsite?: boolean;
  sources?: string[];
};

export type SearchCallbackRequest = {
  url: string;
};

export type SearchCallbackStatus = 'pending' | 'retrying' | 'delivered' | 'failed';

export type SearchCallbackContract = {
  configured: true;
  eventId: string;
  status: SearchCallbackStatus;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastStatusCode?: number;
  deliveredAt?: string;
};

export type SearchRequest = {
  companyType: string;
  sourceMode?: LeadFinderMode;
  researchDepth?: ResearchDepth;
  researchBrief?: string;
  location: SearchLocation;
  count: number;
  phoneRequired: true;
  callback?: SearchCallbackRequest;
  filters?: SearchFilters;
};

export type FeedbackEventType =
  | 'wrong_phone'
  | 'wrong_business'
  | 'wrong_person'
  | 'former_employee'
  | 'duplicate'
  | 'do_not_contact'
  | 'useful';

export type FeedbackRequest = {
  leadId: string;
  eventType: FeedbackEventType;
  reason?: string;
};

export type PhonePolicy = {
  required: true;
  evidence: 'public_phone_evidence';
  lineType: 'not_checked';
  reachability: 'not_checked';
  personalOwnership: 'not_checked';
  emailDelivery: 'not_checked';
};

export type SearchExecution =
  | {
      path: 'durable';
      pollable: true;
      resumable: true;
      startedAt: string;
      lastProgressAt: string;
      completedAt?: string;
    }
  | {
      path: 'stateless';
      pollable: false;
      resumable: false;
      startedAt: string;
      lastProgressAt: string;
      completedAt: string;
    };

export type ProviderCoverage = {
  providerId: string;
  providerName: string;
  status: 'configured' | 'not_configured' | 'returned' | 'failed' | 'partial';
  /** Backward-compatible alias for acceptedCount. */
  leadCount: number;
  phase?: ProviderCoveragePhase;
  outcome?: ProviderCoverageOutcome;
  attemptedCount?: number;
  observedCount?: number;
  acceptedCount?: number;
  reviewCount?: number;
  deferredCount?: number;
  completedCount?: number;
  enrichedCount?: number;
  blockedCount?: number;
  timedOutCount?: number;
  skippedCount?: number;
  decisionMakerRecoveredCount?: number;
  updatedAt?: string;
  message?: string;
};

export type ProviderCoveragePhase = 'queued' | 'running' | 'completed' | 'degraded' | 'skipped';

export type ProviderCoverageOutcome =
  | 'not_started'
  | 'returned'
  | 'empty'
  | 'timed_out'
  | 'blocked'
  | 'rate_limited'
  | 'failed'
  | 'filtered'
  | 'deferred'
  | 'not_configured';

export type ProviderWarning = {
  providerId: string;
  providerName: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
};

export type DecisionMakerPhonePair = {
  status: 'paired' | 'decision_maker_only' | 'phone_only' | 'unpaired';
  phoneAssociation: 'business' | 'person' | 'unknown';
  phoneSourceUrl?: string;
  phoneSourceName?: string;
  personSourceUrl?: string;
};

export type IntegrationLead = {
  id: string;
  name: string;
  category: string;
  city: string;
  state?: string;
  stateCode?: string;
  source: string;
  confidence: number;
  organizationName?: string;
  originalRole?: string;
  normalizedRole?: string;
  decisionMakerName?: string;
  decisionMakerRole?: string;
  decisionMakerSourceUrl?: string;
  decisionMakerPhonePair?: DecisionMakerPhonePair;
  decisionMaker?: boolean;
  employmentStatus?: 'current' | 'probable' | 'uncertain' | 'conflicting' | 'former' | 'unverified';
  mobile?: string;
  email?: string;
  website?: string;
  contactSourceUrl?: string;
  listingUrl?: string;
  publicSocialLinks?: Array<{ platform: string; url: string }>;
  evidence?: LeadEvidence[];
  scores?: Record<string, unknown>;
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  verifiedPhone: boolean;
  verifiedEmail: boolean;
  scrapedAt: string;
  [key: string]: unknown;
};

export type ResearchCandidate = {
  id: string;
  name?: string;
  personName?: string;
  organizationName?: string;
  originalRole?: string;
  location?: string;
  website?: string;
  profileUrl?: string;
  reportedPhone?: string;
  reportedEmail?: string;
  socialLinks?: Array<{ platform: string; url: string }>;
  sourceUrls: string[];
  sourceTitles?: string[];
  evidence?: string;
  grounded: boolean;
  status: 'needs_phone_validation' | 'needs_source_review';
  discoveredAt: string;
};

export type ReviewCandidateReason =
  | 'missing_public_phone'
  | 'invalid_public_phone'
  | 'missing_source_evidence'
  | 'category_mismatch'
  | 'location_mismatch'
  | 'organization_unmatched'
  | 'organization_ambiguous'
  | 'former_or_conflicting'
  | 'website_timeout'
  | 'website_blocked'
  | 'provider_timeout'
  | 'provider_blocked'
  | 'provider_rate_limited'
  | 'deferred_by_budget';

/** Public evidence retained for review and deliberately excluded from export. */
export type ReviewCandidate = {
  id: string;
  providerId: string;
  providerName: string;
  reason: ReviewCandidateReason;
  reasonDetail?: string;
  name?: string;
  personName?: string;
  organizationName?: string;
  originalRole?: string;
  location?: string;
  website?: string;
  profileUrl?: string;
  reportedPhone?: string;
  reportedEmail?: string;
  sourceUrls: string[];
  sourceTitles?: string[];
  evidence?: string;
  relatedLeadIds?: string[];
  discoveredAt: string;
};

export type LeadEvidence = {
  sourceUrl: string;
  sourceName: string;
  sourceFamily?: string;
  authorityTier?: 'A' | 'B' | 'C' | 'D';
  claim: string;
  status: 'confirmed' | 'corroborated' | 'inferred' | 'stale' | 'conflicting' | 'rejected' | 'unknown';
  observedAt?: string;
};

export type SearchProgress = {
  discovered: number;
  enriched: number;
  publicContactsFound?: number;
  phoneExcludedCount?: number;
  suppressedCount?: number;
  publicQueriesAttempted?: number;
  publicProvidersChecked?: number;
  publicQueryFamilies?: string[];
  publicQueryFamilyCounts?: Record<string, number>;
  providerCoverage?: ProviderCoverage[];
  aiAssistance?: 'enabled' | 'disabled' | 'failed' | 'rate_limited';
  totalCandidates: number;
  requestedCount: number;
  foundCount: number;
  duplicatesRemoved: number;
  currentSource: string;
  batchesCompleted: number;
  estimatedRemaining: number;
};

export type SearchResponse = {
  contractVersion?: number;
  searchId: string;
  leads: IntegrationLead[];
  researchCandidates?: ResearchCandidate[];
  reviewCandidates?: ReviewCandidate[];
  meta: {
    sourceMode?: LeadFinderMode;
    execution?: SearchExecution;
    callback?: SearchCallbackContract;
    requestId?: string;
    phonePolicy?: PhonePolicy;
    limitations?: string[];
    qualitySummary?: Record<string, unknown>;
    query: string;
    locationLabel: string;
    researchDepth?: ResearchDepth;
    researchBrief?: string;
    status: SearchStatus;
    progress: SearchProgress;
    totals: {
      total: number;
      withEmail: number;
      withPhone: number;
      withWebsite: number;
    };
    providerWarnings: ProviderWarning[];
  };
};

export type ResearchDossier = {
  contractVersion: number;
  searchId: string;
  sourceMode: LeadFinderMode;
  phonePolicy: PhonePolicy;
  execution?: SearchExecution;
  requestId?: string;
  status: SearchStatus;
  query: string;
  locationLabel: string;
  researchDepth: ResearchDepth;
  researchBrief?: string;
  generatedAt: string;
  limitations: string[];
  providerWarnings: ProviderWarning[];
  providerCoverage: ProviderCoverage[];
  coverage: Record<string, number>;
  qualitySummary: Record<string, unknown>;
  leads: IntegrationLead[];
  researchCandidates?: ResearchCandidate[];
  reviewCandidates?: ReviewCandidate[];
};

export type IntegrationCapabilities = {
  apiVersion: 'v1';
  responseContractVersion: number;
  authentication: {
    ownerRequired: true;
    acceptedHeaders: readonly ['x-api-key', 'authorization'];
    bearerFormat: string;
    apiKeyFormat: string;
  };
  client?: {
    packageName: string;
    version: string;
    runtime: string;
  };
  modes: Array<{
    id: LeadFinderMode;
    name: string;
    executionPaths: readonly string[];
    contract: Record<string, unknown>;
  }>;
  operations: Record<string, string>;
  guarantees: readonly string[];
  requestId?: string;
};

export type IntegrationOpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SearchApiErrorResponse = {
  error: string;
  code: string;
  retryable: boolean;
  requestId: string;
  contractVersion: number;
  details?: unknown;
};

export class LeadFinderApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(
    status: number,
    payload: Partial<SearchApiErrorResponse> & { error?: string },
  ) {
    super(payload.error ?? 'Lead Finder API request failed');
    this.name = 'LeadFinderApiError';
    this.status = status;
    this.code = payload.code ?? 'INTEGRATION_REQUEST_FAILED';
    this.retryable = payload.retryable ?? status >= 500;
    this.requestId = payload.requestId;
    this.details = payload.details;
  }
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type LeadFinderClientOptions = {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  fetch?: FetchImplementation;
  defaultTimeoutMs?: number;
  headers?: Record<string, string>;
};

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type SearchUntilTerminalOptions = RequestOptions & {
  idempotencyKey?: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  maxWaitMs?: number;
  onProgress?: (response: SearchResponse) => void;
};

const activeStatuses = new Set<SearchStatus>(['queued', 'discovering', 'enriching']);

const createRequestId = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `lfp_${globalThis.crypto.randomUUID()}`;
  }

  return `lfp_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
};

const encodePath = (value: string) => encodeURIComponent(value.trim());

const parseJson = (value: string): unknown => {
  if (!value.trim()) return undefined;

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const isErrorPayload = (value: unknown): value is Partial<SearchApiErrorResponse> & { error?: string } =>
  Boolean(value && typeof value === 'object' && ('error' in value || 'code' in value));

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class LeadFinderClient {
  private readonly apiRoot: string;
  private readonly apiKey?: string;
  private readonly bearerToken?: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly defaultTimeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: LeadFinderClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) throw new Error('baseUrl is required');
    if (options.apiKey && options.bearerToken) {
      throw new Error('Use either apiKey or bearerToken, not both.');
    }

    const globalFetch = globalThis.fetch?.bind(globalThis);
    if (!options.fetch && !globalFetch) {
      throw new Error('A fetch implementation is required in this runtime.');
    }

    this.apiRoot = baseUrl.endsWith('/api/v1') ? baseUrl : `${baseUrl}/api/v1`;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.bearerToken = options.bearerToken?.trim() || undefined;
    this.fetchImplementation = options.fetch ?? globalFetch!;
    this.defaultTimeoutMs = Math.max(1_000, options.defaultTimeoutMs ?? 30_000);
    this.defaultHeaders = { ...(options.headers ?? {}) };
  }

  async getCapabilities(options: RequestOptions = {}) {
    return this.request<IntegrationCapabilities>('/capabilities', { method: 'GET' }, options);
  }

  async getOpenApi(options: RequestOptions = {}) {
    return this.request<IntegrationOpenApiDocument>(
      '/capabilities?format=openapi',
      { method: 'GET' },
      options,
    );
  }

  async startSearch(
    request: SearchRequest,
    options: RequestOptions & { idempotencyKey?: string } = {},
  ) {
    if (request.phoneRequired !== true) {
      throw new Error('phoneRequired must remain true for every integration search.');
    }

    return this.request<SearchResponse>(
      '/search',
      {
        method: 'POST',
        headers: options.idempotencyKey
          ? { 'Idempotency-Key': options.idempotencyKey }
          : undefined,
        body: JSON.stringify(request),
      },
      options,
    );
  }

  async getSearch(searchId: string, options: RequestOptions = {}) {
    return this.request<SearchResponse | undefined>(
      `/search/${encodePath(searchId)}`,
      { method: 'GET' },
      options,
    );
  }

  async getEvidence(searchId: string, leadId?: string, options: RequestOptions = {}) {
    const query = leadId ? `?leadId=${encodeURIComponent(leadId)}` : '';
    return this.request<ResearchDossier>(
      `/search/${encodePath(searchId)}/evidence${query}`,
      { method: 'GET' },
      options,
    );
  }

  async cancelSearch(searchId: string, options: RequestOptions = {}) {
    return this.request<SearchResponse>(
      `/search/${encodePath(searchId)}/cancel`,
      { method: 'POST' },
      options,
    );
  }

  async resumeSearch(searchId: string, options: RequestOptions = {}) {
    return this.request<SearchResponse>(
      `/search/${encodePath(searchId)}/resume`,
      { method: 'POST' },
      options,
    );
  }

  async reverifySearch(searchId: string, options: RequestOptions = {}) {
    return this.request<SearchResponse>(
      `/search/${encodePath(searchId)}/reverify`,
      { method: 'POST' },
      options,
    );
  }

  async recordFeedback(
    searchId: string,
    feedback: FeedbackRequest,
    options: RequestOptions = {},
  ) {
    return this.request<SearchResponse>(
      `/search/${encodePath(searchId)}/feedback`,
      { method: 'POST', body: JSON.stringify(feedback) },
      options,
    );
  }

  async searchUntilTerminal(
    request: SearchRequest,
    options: SearchUntilTerminalOptions = {},
  ): Promise<SearchResponse> {
    let response = await this.startSearch(request, options);
    options.onProgress?.(response);

    if (response.meta.execution?.pollable === false || !activeStatuses.has(response.meta.status)) {
      return response;
    }

    const startedAt = Date.now();
    const maxWaitMs = Math.max(1_000, options.maxWaitMs ?? 10 * 60_000);
    let delayMs = Math.max(100, options.pollIntervalMs ?? 1_000);
    const maxPollIntervalMs = Math.max(delayMs, options.maxPollIntervalMs ?? 5_000);

    while (activeStatuses.has(response.meta.status)) {
      if (Date.now() - startedAt >= maxWaitMs) {
        throw new LeadFinderApiError(408, {
          error: 'Search did not reach a terminal state before the client timeout.',
          code: 'INTEGRATION_POLL_TIMEOUT',
          retryable: true,
          requestId: response.meta.requestId,
        });
      }

      await sleep(delayMs, options.signal);
      const next = await this.getSearch(response.searchId, options);
      if (!next) {
        throw new LeadFinderApiError(404, {
          error: 'Search snapshot was not available while polling.',
          code: 'SEARCH_SNAPSHOT_MISSING',
          retryable: true,
          requestId: response.meta.requestId,
        });
      }

      response = next;
      options.onProgress?.(response);
      delayMs = Math.min(maxPollIntervalMs, Math.ceil(delayMs * 1.5));

      if (response.meta.execution?.pollable === false) break;
    }

    return response;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    options: RequestOptions,
  ): Promise<T> {
    const headers = new Headers(this.defaultHeaders);
    headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.apiKey) headers.set('x-api-key', this.apiKey);
    if (this.bearerToken) headers.set('Authorization', `Bearer ${this.bearerToken}`);
    if (!headers.has('X-Request-Id')) headers.set('X-Request-Id', createRequestId());
    if (init.headers) {
      new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutMs = Math.max(1_000, options.timeoutMs ?? this.defaultTimeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImplementation(`${this.apiRoot}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      const body = parseJson(bodyText);

      if (!response.ok) {
        const payload = isErrorPayload(body) ? body : { error: bodyText || response.statusText };
        throw new LeadFinderApiError(response.status, {
          ...payload,
          requestId: payload.requestId ?? response.headers.get('X-Request-Id') ?? undefined,
        });
      }

      return (response.status === 204 ? undefined : body) as T;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
