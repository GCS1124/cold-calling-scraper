# Lead quality roadmap

Updated: 2026-09-08. Scope: improve GMB, LinkedIn public discovery, and AI mode in the existing React/Vite product. No new public API product or endpoints are planned.

## Product outcome

Return useful business contacts that a customer can inspect, prioritize, and act on. Every returned lead must have a structurally valid US phone with public evidence. A business phone is not automatically the owner's mobile. Public observation, numbering-plan validity, line type, ownership, and actual reachability are separate facts.

Willingness to pay must be measured with customers; an engineering score or passing test cannot establish it. The product milestone is an evidence-backed shortlist that saves research time and reduces wrong-company calls.

## Current baseline and verified gaps

Baseline commit: `96df0c1`. The workspace audit found category expansion, bounded public discovery, website extraction, candidate headroom, job leases, cancellation, and source warnings already implemented. Local, durable, and stateless search paths exist separately. The response contract now also carries lifecycle state and a phone-qualified quality summary. Production database, worker, provider-yield, and customer-quality verification remain separate gates.

Observed issues in the baseline:

1. Shared phone keys can merge different LinkedIn people. Shared website domains can merge separate business branches.
2. Deduplication can select a phone from one row and its validation flag or source from another row.
3. Phone eligibility accepts any HTTP URL in evidence, including unrelated or rejected evidence. An internal false flag can disable the supposedly mandatory gate.
4. Website extraction loses the exact page and observation time for individual contacts.
5. A single `verified` label conflates syntax checks with business association and reachability.
6. Stateless duplicate metrics include phone exclusions and results clipped at the requested count.
7. Raw candidates can appear in durable/local snapshots before final phone filtering.
8. Quality scores count provider names as independent corroboration, and do not reduce confidence for stale or conflicting evidence.
9. A failed public provider can produce zero results. Prior successful queries are not evidence that the current source is available.

## Invariants

- All three source choices remain prominent, with Quick / Verified / Pro research depth.
- Mandatory public phone evidence applies to progress snapshots, completed results, history, dossiers, and exports.
- Increase recall through better discovery and association; never invent or attach an unrelated phone to reach a quota.
- Keep individual people, business organizations, and separate locations distinct.
- Preserve field value, source URL, observation date, source kind, and association scope together.
- Search snippets and multiple results pointing to the same source are not independent confirmation.
- AI may interpret requests and propose searches. It cannot manufacture contact facts, employment claims, or verification results.
- Use existing authorized providers. Do not add paid lead databases, paid contact lookups, or new spending commitments.
- Missing or failed checks remain visible. Re-running syntax checks must not advance source-observation dates.

## Architecture

Existing UI -> validated search input -> bounded discovery by mode -> identity resolution -> public website research -> contact evidence -> qualification -> ranking -> result snapshot -> dossier/export. A versioned internal response contract now carries the source mode, mandatory public-phone policy, limitations, provider coverage, execution lifecycle, and phone-qualified quality summary through local, durable, and stateless responses without creating a new public API product.

Shared types describe evidence and quality. Server services own qualification and scoring. UI components render the assessment and offer filters; they do not reinterpret provider data or silently promote legacy records. Existing routes remain internal application transport.

## Delivery phases

### 1. Trust foundation (local implementation verified)

Implement field-specific contact evidence, exact crawler provenance, person/location-safe deduplication, conservative company-phone bridging, and a common quality assessment. Apply phone eligibility at every result boundary. Distinguish duplicates, phone exclusions, and the requested result cap. Add visible quality tiers, explanations, source dates, and exportable proof.

Acceptance: unrelated/rejected evidence cannot qualify a phone; invalid raw numbers cannot inherit a valid flag; two people sharing a switchboard remain separate; branches sharing a domain remain separate; crawl contacts retain their actual source page; stale observations remain stale after validation; all response builders obey the same gate. Adversarial fixtures and browser checks must prove these cases.

### 2. Research crawler and domain accuracy (local trust checks implemented; bounded live validation pending)

Validate official domains against business name, address, phone, and public organization markup. Record whether a domain is confirmed, probable, parked, unrelated, or unavailable. Respect robots rules and site restrictions; bound pages, bytes, redirects, per-domain concurrency, and overall deadlines. Reject login/challenge pages. Capture document hashes and observation dates, and avoid re-reading unchanged documents within the allowed retention window.

Prioritize contact, about, team, leadership, location, services, and careers pages. Extract leadership facts only with names, roles, quotations, and page references. Track contact association per branch. A phone on a multi-location footer does not prove it is a direct branch or person number.

Acceptance: fixtures for parked sites, unrelated redirects, multiple offices, malformed markup, robots disallow, duplicate pages, and hung requests; bounded completion under provider failures; no private-network fetches; every accepted fact has an origin.

Current implementation records a deterministic website identity assessment, robots outcome, exact assessed page, observation timestamp, and SHA-256 document hash. Parked/challenge pages cannot contribute website contact evidence, robots-disallowed roots are not fetched, and weak contact-bearing pages remain usable but are labeled probable with explicit gaps. The remaining validation is a bounded live-provider/domain smoke matrix and retention-aware reuse of unchanged documents.

### 3. Discovery coverage and execution reliability (partial: free-source merge and bounded recovery implemented)

Share mode policy and scheduling across local, durable, and stateless execution. Allocate research time by candidate yield and evidence gaps, with per-provider concurrency and circuit breakers. Preserve partial qualified results on cancellation and time limits. Save enough checkpoints to recover after process loss without duplicate work. Verify storage and worker availability before promising resumable jobs.

GMB: refine category synonyms and location seeds; keep exact city/state boundaries and independently research business contacts. Preserve separate branches and closed-business exclusions. Google Places and OpenStreetMap now run independently in the durable path, and a bounded public-website recovery pass can recover a published phone for phone-missing business candidates. Review current provider storage and attribution rules before changing retention.

LinkedIn: expand public professional discovery through company leadership pages, associations, and public search references; corroborate current company and role. Reuse a proven company contact route for multiple relevant people while labeling it a business route. Quarantine former/conflicting employment for review.

AI: compile the brief into typed supported criteria; show which requirements are enforced versus still unverified. Route company/people discovery according to intent. Honor exclusions. Recover with deterministic query expansion if Gemini is unavailable. Do not label an unsupported criterion as matched. All three modes now expose the same provider-coverage states (`configured`, `not_configured`, `returned`, `failed`, and `partial`) so a zero result cannot be mistaken for an unattempted source.

Acceptance: multi-industry fixtures (dentist, HVAC, plumbing, roofing, legal, software); region boundary tests; query diversity checks; simulated 429/403/timeout/restart/cancellation; complete searches without continuous browser polling when a worker is configured. Local tests now cover independent free-source execution and bounded website recovery; live multi-industry coverage and worker recovery remain pending.

### 4. Qualification and opportunity research (partial: source-family trust and role/org qualification implemented)

Implement independently adjustable company fit, role relevance, freshness, corroboration, and contact requirements under the compulsory phone rule. Score explicit facts, penalize contradictions, and expose reason codes. Keep business contact routes separate from verified personal contact routes. Use objective, dated opportunity signals such as observed hiring pages or published expansion announcements. Absence of an online-booking link in a limited crawl means 'not observed', not 'the business has no booking'.

The current implementation now records independent source families and authority tiers instead of treating provider names or repeated search-engine URLs as independent corroboration. Public professional profiles preserve the published role, normalized decision-maker signal, and organization hint; normalized persistence materializes the person-to-organization relationship with the observed role, relationship status, source document, and observation timestamp. Verification events use stable idempotency keys and contact observations preserve the original observation date. Opportunity wording is now classified into hiring, growth, active-service, conversion-gap, and negative-status types; missing booking links are neutral rather than demand evidence, and former/conflicting employment or unrelated websites reduce research priority with visible reason codes. Calibrated weights and independently reviewed labels remain to be completed.

Acceptance: unsupported owner, current-role, mobile, deliverability, growth, and technology claims never receive a positive verification label. Search engines repeating one profile cannot create multiple independent source families. Rankings change for documented reasons.

### 5. Dossiers, corrections, and customer workflow (partial: evidence dossiers and normalized identity links implemented)

Provide a compact research dossier for every mode: why it fits, phone source and scope, email check level, observed dates, contradictions, opportunity evidence, and next action. Add saved qualification presets, resumable search history, and evidence-bearing exports. Record user corrections (wrong number, wrong business, former employee, duplicate, do not contact) with timestamps and explanations. Enforce suppression before export and later searches. Keep corrections scoped to the proper user/workspace; verify authorization before sharing data.

The normalized research path now persists source-family/authority metadata, public profile identity, organization identity, role, employment relationship status, contact observation dates, and idempotent phone/email verification events. Search responses and evidence dossiers now carry lifecycle metadata plus the same phone-qualified quality rollup, including eligible/review counts, freshness, tier distribution, and source-family counts; exports preserve public role and organization fields. Durable search jobs now carry an optional authenticated owner and enforce owner-scoped reads and mutations when auth is enabled. Feedback events, suppression enforcement, shared-workspace authorization, and user-facing correction workflows are still pending.

Acceptance: results and exports agree; changing filters cannot bypass phone eligibility or suppression; observations remain historically traceable; correcting one branch does not corrupt all businesses sharing a domain or call center. Existing UI search/auth/history flows continue to work.

### 6. Evaluation and release (pending)

Build a labeled evaluation corpus across at least five industries and ten states, including multi-location businesses, similarly named companies, obsolete biographies, shared phones, missing contacts, and conflicting sources. Separate synthetic regression fixtures from independently reviewed live records. Target 500 businesses, 200 people, and 300 contact points for the commercial-quality audit; do not fabricate labels or imply this sample exists before review.

Record company and domain precision, phone-business association, duplicate rate, evidence coverage, freshness, employment accuracy, time to first qualified result, final yield, provider errors, and cost per accepted lead. Use explicit denominators and confidence intervals; report coverage and precision separately. Proposed release gates: >=95% company/domain precision, >=90% phone-business and current-employment association, <=2% duplicates, 100% traceable exported phones, and zero invented contacts. These are targets, not current measured performance. Mailbox deliverability and mobile precision remain unmeasured until real evidence exists.

Run automated unit/integration checks, recorded provider contract fixtures, queue recovery tests, desktop/mobile Playwright checks, and a small real-provider smoke matrix. Publish only after reviewing the actual changes and confirming deployment/readback separately from Git publication. Remove temporary browser artifacts from the repository before publication.

## Customer validation

Invite willing pilot users to evaluate blind samples from each mode against their current workflow. Measure accepted leads per hour, wrong-company rate, time saved verifying contacts, repeat searches, exports actually used, and stated willingness to pay. Do not send outreach or place calls automatically. Treat paid conversion and repeat usage as market evidence, not something that can be guaranteed by code.

## Completion ledger

| Deliverable | State | Evidence required |
| --- | --- | --- |
| Detailed implementation roadmap | Written | This document and source audit |
| Trust foundation | Local regression and browser checks pass | 281 server tests, 55 client tests, 4 shared taxonomy tests, both builds, runtime boot, lint, and mocked browser flow |
| Crawler/domain checks | Partial: unrelated redirects and robots/parked pages rejected locally | Official-domain validation and bounded live checks still pending; unchanged-document reuse is not yet persistent |
| Discovery reliability across three modes | Partial: GMB free-source merge, bounded public-phone recovery, shared provider-coverage contract, and durable replay-safe starts implemented locally | Recovery, retention reuse, and real-source smoke matrix still pending; stateless fallback cannot guarantee cross-instance replay |
| Typed qualification / role and signal research | Partial: source-family trust, authority tiers, role normalization, organization hints, relationship persistence, opportunity taxonomy, and contradiction penalties implemented | Calibrated weights and independently reviewed multi-industry acceptance labels |
| Dossiers / feedback / suppression | Partial: search responses and evidence dossiers expose lifecycle, contract, coverage, and quality summaries; source-family metadata, person-to-organization links, role fields, idempotent observation persistence, and optional owner-scoped durable jobs added | Feedback, suppression, shared-workspace authorization, user correction and live export checks still pending |
| Commercial quality benchmark | Pending | Reviewed dataset and measured results |
| Production release | Pending | Commit, remote SHA, deployment, live readback |
| Customer willingness to pay | Unproven | Pilot usage and customer feedback |

The active objective remains open until the agreed product work and verification are complete. A passing synthetic test suite alone does not close the commercial-quality goal.

## Verified checkpoint: 2026-09-08

The common public-phone gate now runs on local, durable, stateless and dossier responses. It matches the phone value to contact evidence, rejects malformed/rejected/mismatched evidence and private URLs, and cannot be disabled by an untyped false flag. Legacy completed jobs with zero eligible contacts return a failure with an explicit notice rather than a green success. Raw candidates remain available internally for enrichment.

Deduplication keeps distinct professional profiles and business branches separate. Valid contacts retain their corresponding source, rather than inheriting another record's validation flag. A proven business listing can supply a business contact route to multiple matching people; former/conflicting employment and ambiguous matches are not bridged.

Website enrichment records exact contact-page URLs and observation times, recovers from invalid existing phone values, and refuses unrelated-domain redirects. Website and listing corroboration requires matching phone values, recent observations and different hosts. A fresh record timestamp cannot refresh an old observation. Snippet evidence is labeled separately. None of these checks proves personal ownership, mobile line type, reachability or mailbox deliverability.

The three-mode UI now includes common quality filters, evidence explanations, source links, observation dates and next actions. Legacy records need refreshed quality metadata before file export, and changing a phone invalidates its old export assessment. Mobile source controls and expanded evidence fit the viewport; the export bar stays in normal flow on mobile so it does not obscure evidence.

All three modes now render a shared provider-coverage panel. `configured`, `not_configured`, `returned`, `failed`, and `partial` are distinguished in the UI; provider observation counts are explicitly not treated as unique final leads. The internal response contract is documented in `docs/search-response-contract.md` and is covered by server contract/merge tests.

The normalized evidence graph now distinguishes source families and authority tiers, so repeated search providers or repeated URLs cannot inflate corroboration. Public profile leads retain organization and role metadata, and persisted research links a person to the publicly inferred organization with an observed relationship status and source document. Contact observations retain their source observation date, and phone/email verification writes are idempotent. Search responses now expose the same lifecycle and quality rollup used by dossiers, so an integration can decide whether to poll, resume, review, or export without a second quality request. Search and evidence errors now carry stable codes, retryability, request IDs, and a versioned error contract; durable search starts also deduplicate retries with a request fingerprint and bounded `Idempotency-Key`. The browser client now sends an idempotency key for every start and propagates the active Supabase access token when one exists. When `LEAD_FINDER_AUTH_REQUIRED=true`, server verification and owner-scoped job access are enforced across all search routes. These changes improve downstream integration reliability but do not prove mobile line type, reachability, personal ownership, email deliverability, or commercial lead quality.

The public Google Maps fallback now skips detail-page navigation when a result card already contains a public phone and blocks non-essential browser resources. This reduces the resource-limit failure mode without weakening the public-phone evidence gate. Research scoring now distinguishes positive opportunity signals from neutral conversion gaps and negative status signals, and exposes contradiction flags and penalties for review; these are deterministic prioritization aids, not accuracy probabilities.

Verification commands:

```sh
(cd server && npx vitest run --pool=forks --maxWorkers=1 --reporter verbose)
(npx vitest run --pool=forks --maxWorkers=1 shared/__tests__/opportunity-signals.test.ts)
npm run test:runtime --workspace server
(cd client && npx vitest run --coverage --pool=forks --maxWorkers=1 --reporter verbose)
npm run build
npm run lint --workspace client
E2E_ARTIFACT_DIR=/tmp/lead-quality-browser-20260908 npm run test:e2e
git diff --check
```

Browser acceptance uses explicit synthetic search/health responses. It covers the three mode choices, source/evidence display, quality filters, Excel download, failure/retry, mobile selector/panel bounds and JavaScript page errors. Screenshots were also inspected. These are UI contract checks, not live-provider yield or commercial-quality measurements. No new provider calls, paid sources, public API endpoints, deployments or customer outreach were performed for this checkpoint. Vite still reports a main-bundle size warning; it was not hidden.

The root `npm test` wrapper was not used for this checkpoint because it did not
terminate in a bounded run; the server unit suite, server runtime boot check, and
client suite completed separately using the commands above.

The provider environment file is excluded from Git while its local copy is preserved. The checked sensitive fields in the tracked copy were empty; no claim is made that Git-history credentials were exposed. Keys pasted in chat should still be rotated by the account owner. Live credentials and database configuration were not changed.
