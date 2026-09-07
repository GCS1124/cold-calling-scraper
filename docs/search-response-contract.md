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
- `meta.progress.providerCoverage`: provider observations with `configured`,
  `not_configured`, `returned`, `failed`, or `partial` status.

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
