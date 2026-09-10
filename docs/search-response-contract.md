# Search response contract

The two public search modes share one additive response contract. It is used by the
web client, the durable worker, the stateless fallback, and the versioned
first-party integration preview under `/api/v1`; it does not expose a provider
endpoint.

## Envelope

Every runtime response includes:

- `contractVersion`: currently `2`.
- `meta.sourceMode`: `gmb` or `ai`. Older `linkedin` start payloads are
  canonicalized to `ai` before execution.
- `meta.phonePolicy`: a mandatory `public_phone_evidence` gate. The contract
  deliberately reports line type, reachability, personal ownership, and email
  deliverability as `not_checked`; a published business phone is not proof of
  any of those claims.
- `meta.limitations`: mode-specific limitations that must be shown or retained
  by downstream integrations.
- `meta.execution`: lifecycle metadata. `durable` responses are pollable and
  resumable; stateless AI fallback responses are already complete and must not
  be polled. `lastProgressAt` is the latest progress
  timestamp, and `completedAt` is present for terminal responses.
- `meta.qualitySummary`: the same phone-qualified quality rollup used by the
  evidence dossier, including eligible leads, review count, fresh phone
  observations, quality tiers, and independent source-family counts. This is a
  summary of returned leads, not a probability or deliverability guarantee.
- `meta.progress.providerCoverage`: provider observations with `configured`,
  `not_configured`, `returned`, `failed`, or `partial` status.
- `researchCandidates` (AI mode when populated): every grounded or source-review
  candidate returned by Gemini, including public source URLs, evidence, social
  links, and model-reported phone/email fields labeled as unverified. These
  records are retained for research and are never included in the exportable
  `leads` array until independent public phone validation succeeds.

## Lead quality and identity fields

Each lead may carry additive evidence and research fields that are safe for a
downstream integration to preserve without interpreting provider-specific
labels:

- `scores.independentSourceCount` and `scores.sourceFamilies` count distinct
  evidence families, not search providers, repeated URLs, or snippet copies.
- Evidence items may include `sourceFamily` and `authorityTier` (`A` through
  `D`) alongside the source URL, claim, status, and observation date.
- Public professional profiles may include `organizationName`, `originalRole`,
  `normalizedRole`, `decisionMaker`, and `employmentStatus`. These fields are
  public-evidence signals, not proof of current employment, ownership, or a
  personal phone number.
- Public phone evidence remains compulsory for an eligible final lead. A
  business phone can be retained as a business contact route for a person, but
  it must not be labeled as that person's mobile or direct line.

The normalized research store persists source documents, person/organization
relationships, role and relationship status, observation timestamps, and
idempotent phone/email verification events. This makes the internal contract
stable enough for an integration layer while remaining honest about missing
line-type, reachability, ownership, and mailbox checks.

The evidence dossier response adds the same contract metadata plus
`providerCoverage`, `coverage.observed`, `coverage.excludedByPhone`, and a
`qualitySummary` containing tier counts, fresh phone observations, and
source-family lead counts. Export rows also preserve organization, published
and normalized role, employment status, decision-maker signal, and independent
source-family metadata. These are additive fields; consumers should continue
to enforce `phonePolicy.required` and inspect each lead's source evidence.

NotaryCafe coverage uses a bounded public-search-index adapter on every AI
search. It queries public search engines for category- and location-aware
`notarycafe.com` profile references, keeps only relevant notary records whose
indexed snippet exposes a parseable US phone, and sends those records through
the same normalization, evidence, deduplication, and export gate as every
other source. Non-notary probes are retained for provider coverage but cannot
promote unrelated profiles. It does not fetch NotaryCafe pages directly or
bypass Cloudflare, CAPTCHA, login, geo restrictions, or private profile
controls. Indexed references may be stale and should be reverified before
outreach.
The adapter bounds query count, provider timeout, result count, and response-body
bytes (`NOTARYCAFE_INDEX_MAX_QUERIES`, `NOTARYCAFE_INDEX_TIMEOUT_MS`,
`NOTARYCAFE_INDEX_MAX_RESULTS`, and `NOTARYCAFE_INDEX_MAX_BODY_BYTES`). The
LinkedIn and public contact-search paths apply the same response-body guard.

## HTTP errors and tracing

Vercel search and evidence routes preserve the human-readable `error` string
for the current client and add `code`, `retryable`, `requestId`, and
`contractVersion` to error responses. Every HTTP response also returns the
`X-Request-Id` header; a caller may provide a bounded `X-Request-Id`
value for log correlation. A request id identifies the transport attempt, not
a user, workspace, or authorization grant.

Durable search starts also accept a bounded `Idempotency-Key` header. The
server stores the key with a normalized request fingerprint and returns the
same search snapshot for a replay of the same request instead of starting a
second discovery job. Reusing a key with different search criteria returns
`409` with code `IDEMPOTENCY_KEY_REUSED`; clients should create a new key for
the new request. Stateless LinkedIn or AI fallback responses cannot provide
cross-instance replay guarantees because no durable job store is available;
their `meta.execution.path` remains `stateless` and that limitation is not
hidden.

The client transport sends an idempotency key for every search start. An
integration should persist one key for the lifetime of a logical search and
reuse it after a timeout or lost response; a new business search must use a new
key. Client errors preserve the server `code`, `retryable`, `requestId`,
`contractVersion`, `details`, and HTTP status so callers can retry transient
failures without matching human-readable text.

## Authentication and ownership

When `LEAD_FINDER_AUTH_REQUIRED=true`, every search, snapshot, evidence,
cancel, resume, and reverify request must carry a Supabase access token in the
`Authorization: Bearer <token>` header. The server verifies that token against
the configured Supabase Auth endpoint using `SUPABASE_PUBLISHABLE_KEY` or the
legacy `SUPABASE_ANON_KEY`; service-role and secret keys are never sent to the
browser. A verified user id is stored as the search owner and is required for
all later durable reads and mutations. A different user receives the same
not-found behavior as an expired search id.

If the flag is unset, local and preview deployments retain anonymous
development compatibility. That is intentionally not a production security
posture: production must set the flag and configure Supabase Auth, otherwise
the deployment does not provide tenant isolation. Stateless LinkedIn and AI
fallbacks still verify the caller before returning a response but cannot offer
cross-instance replay or later owner-scoped polling without durable storage.

The versioned `/api/v1` integration surface always requires an owner. Server-to-
server clients may send `x-api-key: <integration key>`; the server compares a
SHA-256 digest against `LEAD_FINDER_INTEGRATION_API_KEYS` and never stores or
returns the raw key. A request must use either the integration key or a
Supabase bearer token, not both. The unversioned application routes retain
their existing authentication behavior for browser compatibility.

## Feedback and suppression

The existing internal application transport accepts a correction event at
`POST /api/search/:searchId/feedback`. This is not a new public API product or
provider endpoint. The browser sends only `leadId`, a bounded `eventType`, and
an optional reason; the server derives suppression keys from the stored,
phone-qualified lead. Supported events are `wrong_phone`, `wrong_business`,
`wrong_person`, `former_employee`, `duplicate`, `do_not_contact`, and `useful`.

Feedback requires an authenticated owner even when anonymous search compatibility
is enabled. Suppression is owner-scoped and is applied to both public modes after
the mandatory phone gate and before response totals, quality summaries, evidence
dossiers, and export rows. Responses expose `meta.progress.suppressedCount` and
a `workspace-suppression` provider notice when a result is intentionally hidden.
`useful` records learning data without suppressing the lead. A workspace
correction never modifies public source data and is not treated as global.

Durable feedback requires the Postgres connection used by the durable search
store. Local development can use a process-memory fallback; Vercel returns a
structured persistence error instead of silently losing a correction. Team or
shared-workspace authorization and reviewed correction labels are not implied
by the owner id and remain separate product work.

## Coverage semantics

`leadCount` is the number of candidates observed from that provider before the
final cross-provider dedupe and phone gate. It is not a unique-lead guarantee.

- `configured`: the source is available but has not returned an observation yet.
- `not_configured`: the source is intentionally unavailable in this execution.
- `returned`: the source returned candidates, including a zero-candidate response
  when the provider completed without an error.
- `failed`: the source failed or was blocked for the observed execution.
- `partial`: at least one attempt failed and another attempt returned data.

Coverage is merged by provider ID across regional batches. Repeated status
messages are deduplicated and capped so a long search cannot create an
unbounded response payload.

## Mode guarantees

### GMB

Google Places is used only when configured. Free public listing discovery remains
an independent fallback. Website recovery is bounded and only promotes publicly
observed phone or email evidence.

### LinkedIn

Discovery uses public search results only. Private profiles, authenticated
sessions, Premium data, and paywalls are not accessed. Public listings and
business websites can corroborate an organization and supply a public phone;
the final phone gate still applies.

### AI

Gemini can expand public search lenses and return grounded public research
candidates. Candidates and cited source details remain available for review even
when the required public-phone gate excludes them from export. Public discovery
providers supply independently validated lead and contact facts, including
search-indexed NotaryCafe public profile references. Apollo, Lusha,
ZoomInfo, and RocketReach are audited for limitation messaging only and are never
called; no paid lead database is required. Gemini usage remains subject to the
configured account's limits or charges. The server serializes Gemini requests,
rotates across the configured key pool on `429`, honors short `Retry-After`
hints, and opens a bounded in-process cooldown only after the available pool is
exhausted. Each AI search uses one
seed-aware grounded Gemini pass; GMB/public-listing seeds are folded into that
pass instead of triggering a second grounded request. If Gemini is rate-limited,
`meta.progress.aiAssistance` is `rate_limited`, the coverage entry is `partial`,
and deterministic public discovery continues unchanged. Tune the optional
`GEMINI_MIN_REQUEST_GAP_MS`, `GEMINI_MAX_RETRIES`, `GEMINI_MAX_RETRY_WAIT_MS`,
`GEMINI_RATE_LIMIT_COOLDOWN_MS`, and `GEMINI_FALLBACK_RETRY_MS` environment
variables, plus `GEMINI_KEY_ROTATION_ATTEMPTS`,
`GEMINI_AUTH_FAILURE_COOLDOWN_MS`, `GEMINI_TRANSIENT_FAILURE_COOLDOWN_MS`, and
`GEMINI_QUERY_CACHE_TTL_MS`, when the configured account has different quota
characteristics.

The evidence/dossier response also carries `researchCandidates` separately from
`leads`, so requesting evidence does not discard AI-mode references that still
need source or phone review.

For quota resilience, configure either `GEMINI_API_KEYS` as a comma/newline/
semicolon-separated pool or individual `GEMINI_API_KEY_1` through
`GEMINI_API_KEY_20` variables. The legacy `GEMINI_API_KEY` variable remains
supported and is added to the pool. Requests rotate round-robin across healthy
keys; a `429` quarantines only the active key, then retries each configured key
once per request before returning `rate_limited`. Raw keys are never included in
coverage, logs, or response payloads. `GEMINI_KEY_ROTATION_ATTEMPTS` can lower
the per-request rotation cap when needed. A bounded in-process LRU cache reuses
successful query plans for the configured TTL, and invalid or transiently failed
keys are isolated without interrupting deterministic public discovery.
