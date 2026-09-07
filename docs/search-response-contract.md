# Search response contract

The three search modes share one additive response contract. It is an internal
contract used by the web client, the durable worker, and the stateless fallback;
it does not create a new public API product or expose a new provider endpoint.

## Envelope

Every runtime response includes:

- `contractVersion`: currently `2`.
- `meta.sourceMode`: `gmb`, `linkedin`, or `ai`.
- `meta.phonePolicy`: a mandatory `public_phone_evidence` gate. The contract
  deliberately reports line type, reachability, personal ownership, and email
  deliverability as `not_checked`; a published business phone is not proof of
  any of those claims.
- `meta.limitations`: mode-specific limitations that must be shown or retained
  by downstream integrations.
- `meta.execution`: lifecycle metadata. `durable` responses are pollable and
  resumable; `stateless` LinkedIn and AI fallback responses are already
  complete and must not be polled. `lastProgressAt` is the latest progress
  timestamp, and `completedAt` is present for terminal responses.
- `meta.qualitySummary`: the same phone-qualified quality rollup used by the
  evidence dossier, including eligible leads, review count, fresh phone
  observations, quality tiers, and independent source-family counts. This is a
  summary of returned leads, not a probability or deliverability guarantee.
- `meta.progress.providerCoverage`: provider observations with `configured`,
  `not_configured`, `returned`, `failed`, or `partial` status.

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

AI assistance is optional query wording support. Public discovery providers
supply the leads and contact facts. Apollo, Lusha, ZoomInfo, and RocketReach are
audited for limitation messaging only and are never called; no paid database is
required.
