# Lead Finder Integration API

Status: versioned integration surface in preview. Provider APIs remain an
implementation detail; this contract exposes one stable first-party surface
for GMB, public LinkedIn, and free AI-assisted discovery.

## Boundary

The integration surface does not expose Apollo, Lusha, ZoomInfo, RocketReach,
LinkedIn login sessions, private profiles, or contact-reveal credits. Discovery
uses only public, legally accessible sources already configured on the server.
Every final lead must pass the mandatory public-phone evidence gate. A public
business number is not represented as a verified personal mobile, direct line,
reachability result, or mailbox-delivery result.

## Base Paths

The versioned surface is rooted at `/api/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/capabilities` | Discover the contract, modes, operations, and guarantees |
| `POST` | `/api/v1/search` | Start one GMB, LinkedIn, or AI search |
| `GET` | `/api/v1/search/:searchId` | Read a durable snapshot and advance background work |
| `GET` | `/api/v1/search/:searchId/evidence` | Read the source-backed dossier |
| `POST` | `/api/v1/search/:searchId/cancel` | Request cancellation |
| `POST` | `/api/v1/search/:searchId/resume` | Resume a cancelled durable search |
| `POST` | `/api/v1/search/:searchId/reverify` | Re-run deterministic checks without refetching providers |
| `POST` | `/api/v1/search/:searchId/feedback` | Save owner-scoped correction or usefulness feedback |

The older `/api/search` routes remain application transport for the web client.
Consumers should use `/api/v1` so a future contract revision can be introduced
without silently changing integration behavior.

## Authentication

Versioned search operations always require an owner. Two server-side options are
supported:

1. `Authorization: Bearer <Supabase access token>` for an authenticated user.
2. `x-api-key: <integration key>` for a server-to-server integration.

API keys are never stored in source control or sent to the browser. Configure
the server with `LEAD_FINDER_INTEGRATION_API_KEYS` as JSON containing only
SHA-256 hashes and owner identifiers:

```json
[
  {
    "id": "crm-production",
    "ownerId": "supabase-user-or-workspace-id",
    "sha256": "64-lowercase-hex-characters"
  }
]
```

Generate the hash outside the repository, store the raw key only in the
integration secret manager, and rotate by adding a second record before
removing the old one. A valid key maps every search and feedback event to one
`ownerId`; a caller cannot submit an owner id in the request body.

If the key configuration is absent or malformed, the integration surface fails
closed with `503 AUTH_UNAVAILABLE`. An absent key fails with `401 AUTH_REQUIRED`
and an incorrect key fails with `401 AUTH_INVALID`.

## Traffic Protection

Versioned search operations apply a per-credential per-minute limit. The
default is 60 requests; configure `LEAD_FINDER_INTEGRATION_RATE_LIMIT_PER_MINUTE`
to a bounded value between 1 and 10,000. Responses expose
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; a blocked
request returns `429 INTEGRATION_RATE_LIMITED` with `Retry-After`.

When Postgres is configured, counters are shared across warm workers through a
durable bucket table. Local and preview deployments may use a process-local
fallback. Set `LEAD_FINDER_INTEGRATION_REQUIRE_DURABLE_RATE_LIMIT=true` to
fail closed instead of using that fallback when operating production traffic.
The counter is per credential, not a substitute for customer-specific billing
quotas or a full audit log.

## Start Request

```http
POST /api/v1/search
Authorization: Bearer <token>
Idempotency-Key: crm-job-2026-09-08-0001
Content-Type: application/json
```

```json
{
  "companyType": "HVAC contractor",
  "sourceMode": "ai",
  "researchDepth": "pro",
  "location": {
    "mode": "cityState",
    "city": "Austin",
    "stateCode": "TX"
  },
  "count": 100,
  "phoneRequired": true,
  "researchBrief": "Find current owner or operations decision-makers. Prefer official business phones and public role evidence."
}
```

Allowed `sourceMode` values are `gmb`, `linkedin`, and `ai`. Allowed research
depths are `quick`, `verified`, and `pro`. `count` is bounded to 50 through 500
and `phoneRequired` cannot be disabled. The location is either one of `EST`,
`CST`, `MST`, `PST` or an exact US city/state pair.

The initial response is a complete stateless result or a durable snapshot. Do
not assume that `200` means the final lead list is ready; inspect
`meta.execution.path` and `meta.status`.

## Lifecycle

Durable responses advertise:

```json
{
  "meta": {
    "execution": {
      "path": "durable",
      "pollable": true,
      "resumable": true
    },
    "status": "discovering"
  }
}
```

Poll `GET /api/v1/search/:searchId` using bounded backoff until `complete`,
`failed`, or `cancelled`. Use the same `Idempotency-Key` when a start response
is lost; the same owner and normalized request return the existing job instead
of creating a duplicate. Reusing the key with different criteria returns
`409 IDEMPOTENCY_KEY_REUSED`.

Stateless LinkedIn and AI fallbacks advertise `pollable: false` and
`resumable: false`; their response is final for that attempt. They cannot
promise cross-instance replay without durable storage. GMB durable search and
all owner-scoped feedback require the configured Postgres connection.

## Contract Guarantees

- `contractVersion` identifies the response shape; integrations must reject or
  explicitly handle unknown major contract versions.
- `meta.phonePolicy.required` is always true.
- `meta.qualitySummary` and `meta.progress.providerCoverage` describe returned
  evidence and provider attempt state, not probability or deliverability.
- `meta.limitations` is part of the data contract and must not be discarded.
- Every response includes `meta.requestId` when delivered through HTTP, and
  every error includes `requestId`, `code`, `retryable`, and `contractVersion`.
- Evidence retains source URL, source family, authority tier, claim, status,
  and observation date where available.
- `feedback` accepts only a lead id, bounded event type, and optional bounded
  reason. The server derives phone, profile, organization, and branch keys from
  the stored lead; the client cannot rewrite contact identity.

## Mode Behavior

### GMB

Google Places is used when configured. Free public listing discovery remains an
independent fallback. Website recovery is bounded and may add a phone only when
it is publicly observed on an assessed business website. Provider warnings and
unconfigured Google access remain visible.

### LinkedIn

Only public profile references from public search and public pages are used.
Private profiles, authenticated sessions, Premium data, and paywalls are not
accessed. A company phone may be retained as a business contact route for a
matching public person, but it is not labeled as that person's mobile or direct
line. Former or conflicting employment remains reviewable rather than being
silently treated as current.

### AI

AI assistance may rewrite or expand query wording. Public discovery providers
supply the lead facts and contact evidence. If optional Gemini assistance is
unavailable, deterministic query expansion continues where supported. AI never
manufactures a person, owner claim, phone, email, employment relationship, or
verification result.

## Error Handling

Retry only when `retryable` is true. Do not match human-readable text to decide
whether to retry.

| Code | HTTP | Caller action |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | Supply a bearer token or API key |
| `AUTH_INVALID` | 401 | Re-authenticate or rotate the integration key |
| `AUTH_UNAVAILABLE` | 503 | Retry after the auth configuration/service recovers |
| `INVALID_SEARCH_REQUEST` | 400 | Fix the bounded request payload |
| `INVALID_IDEMPOTENCY_KEY` | 400 | Send a safe bounded key |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Create a new key for different criteria |
| `SEARCH_PERSISTENCE_UNAVAILABLE` | 503 | Configure/restore Postgres before durable GMB work |
| `LEAD_NOT_FOUND` | 404 | Refresh the search snapshot or discard the stale lead id |
| provider-specific search failure | 502/500 | Retry only when the response says it is retryable |

## Rollout Plan

1. Freeze the v1 contract and generate a typed client from the capabilities
   response; do not couple CRM code to provider names or UI labels.
2. Configure one API key per integration owner, enable Postgres, and verify
   owner isolation with two test keys before accepting customer traffic.
3. Keep durable rate limiting enabled, then add audit-log retention, key usage
   metrics, and customer-specific quotas before production promotion. The
   built-in counter is a traffic guard, not a billing or usage ledger.
4. Add a worker-backed completion callback only after durable job state and
   retry semantics are measured. Until then, poll using the advertised lifecycle
   flags; do not invent webhook delivery guarantees.
5. Run the reviewed multi-industry corpus and live provider smoke matrix. Track
   accepted leads per hour, phone-business association, duplicate rate,
   freshness, provider failure rate, and repeat usage separately for GMB,
   LinkedIn, and AI.
6. Promote only when the measured quality gates in the lead-quality roadmap are
   met. A green synthetic suite does not prove provider yield or willingness to
   pay.
