# Lead Finder Pro MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fast MVP of Lead Finder Pro with a premium React/Vite UI, a Node/Express search API, hybrid API-plus-scraper providers, and CSV/XLSX export.

**Architecture:** Use a root npm workspace with `client` and `server` packages. The server owns provider orchestration and returns normalized lead records; the client owns search UX, table operations, filters, and export.

**Tech Stack:** React, Vite, TypeScript, Tailwind CSS, Express, Zod, Axios, Cheerio, Playwright, Vitest, Testing Library, SheetJS.

---

### Task 1: Workspace Scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `client/*`
- Create: `server/*`

- [ ] Create the root workspace configuration with scripts for `dev`, `build`, and `test`.
- [ ] Scaffold the Vite React TypeScript client.
- [ ] Scaffold the TypeScript Express server.
- [ ] Install dependencies for UI, testing, scraping, validation, export, and concurrency control.

### Task 2: Server Contract First

**Files:**
- Create: `server/src/types/lead.ts`
- Create: `server/src/types/search.ts`
- Create: `server/src/services/lead-validation.ts`
- Create: `server/src/services/lead-deduplication.ts`
- Create: `server/src/services/__tests__/lead-services.test.ts`

- [ ] Write failing tests for lead validation and deduplication.
- [ ] Implement the minimal validation helpers and deduplication rules to make the tests pass.
- [ ] Keep the shared search and lead contracts small and explicit.

### Task 3: Provider Layer and Orchestrator

**Files:**
- Create: `server/src/providers/provider.ts`
- Create: `server/src/providers/google-places.ts`
- Create: `server/src/providers/gemini.ts`
- Create: `server/src/providers/justdial.ts`
- Create: `server/src/providers/indiamart.ts`
- Create: `server/src/providers/index.ts`
- Create: `server/src/services/search-orchestrator.ts`
- Create: `server/src/services/__tests__/search-orchestrator.test.ts`

- [ ] Write failing tests for query expansion fallback and partial provider failure behavior.
- [ ] Implement the provider interface and stub-real provider adapters.
- [ ] Implement the search orchestrator with concurrency limits and provider warnings.

### Task 4: HTTP API

**Files:**
- Create: `server/src/app.ts`
- Create: `server/src/routes/search.ts`
- Create: `server/src/index.ts`
- Create: `server/src/routes/__tests__/search-route.test.ts`

- [ ] Write failing route tests for valid searches and invalid request bodies.
- [ ] Implement the Express app, route validation, and JSON response shape.
- [ ] Keep route logic thin by delegating to the orchestrator.

### Task 5: Client Foundation

**Files:**
- Create: `client/src/types/lead.ts`
- Create: `client/src/services/search-service.ts`
- Create: `client/src/hooks/use-search-history.ts`
- Create: `client/src/utils/export.ts`
- Modify/Create: `client/src/main.tsx`, `client/src/App.tsx`, `client/src/index.css`

- [ ] Set up global styling, font loading, and app shell.
- [ ] Implement the API service layer with typed request and response objects.
- [ ] Implement local search history storage.
- [ ] Implement export helpers for CSV and XLSX.

### Task 6: Premium Search and Results UI

**Files:**
- Create: `client/src/components/search/*`
- Create: `client/src/components/results/*`
- Create: `client/src/components/export/*`
- Create: `client/src/components/ui/*`
- Create: `client/src/pages/home-page.tsx`
- Create: `client/src/pages/results-page.tsx`
- Create: `client/src/tests/app.test.tsx`

- [ ] Write failing UI tests for search submission and results rendering.
- [ ] Implement the premium hero and search form.
- [ ] Implement the summary row, filters, results table, and export modal.
- [ ] Add motion, loading skeletons, and empty/error states without turning the UI into a card grid.

### Task 7: Verification

**Files:**
- Modify as needed based on failures

- [ ] Run backend tests.
- [ ] Run frontend tests.
- [ ] Run workspace builds.
- [ ] Fix verification failures before claiming completion.

## Self-Review

Spec coverage:

- Search UI: covered in Tasks 5-6
- Backend orchestration: covered in Tasks 2-4
- Export flow: covered in Task 5 and Task 6
- Deduplication and validation: covered in Task 2
- Hybrid providers: covered in Task 3

Placeholder scan:

- No `TODO`, `TBD`, or vague implementation placeholders included

Type consistency:

- Shared concept names are `Lead`, `SearchRequest`, `SearchResponse`, `ProviderWarning`
