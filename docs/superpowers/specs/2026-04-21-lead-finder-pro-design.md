# Lead Finder Pro MVP Design

**Date:** 2026-04-21

## Goal

Build a fast, single-user B2B lead finder that searches by company category and city, aggregates results from API and scraping providers, validates and deduplicates the data, and lets the user export selected leads as CSV or XLSX.

## Product Scope

The MVP is intentionally narrow:

- Single-user, no authentication
- React + Vite frontend
- Node + Express backend
- Server-side provider orchestration only
- Search history stored in localStorage
- Results export to CSV and XLSX

Out of scope for MVP:

- Billing
- Team features
- Background jobs
- Database persistence
- Heavy AI parsing of raw HTML
- Admin dashboards

## Architecture

The system is a small monorepo with separate `client` and `server` apps.

- The frontend owns the search UX, filter state, row selection, and export flow.
- The backend owns query expansion, provider execution, normalization, deduplication, validation, and partial-failure handling.
- All scraping is server-side. The browser never scrapes third-party sites directly.

## Frontend

The frontend uses React, Vite, TypeScript, Tailwind, and a service layer.

Key UI areas:

- Search hero with category, city, count slider, and CTA
- Search history chips
- Summary metrics row
- Filters sidebar
- Results table with sorting and row selection
- Export modal for CSV/XLSX

The design direction is premium but restrained:

- Warm light background
- Deep blue primary action
- Strong typography and calm spacing
- One main visual idea in the hero instead of dashboard-card clutter

## Backend

The backend uses Express, TypeScript, Zod, Playwright, Cheerio, and provider adapters.

Providers in MVP:

- Google Places API
- Gemini query expansion and enrichment
- JustDial scraper
- IndiaMART scraper

Each provider returns the same normalized `Lead` shape. Failures are isolated and reported as provider warnings instead of hard search failures.

## Data Model

```ts
export type Lead = {
  id: string;
  name: string;
  mobile?: string;
  email?: string;
  website?: string;
  address?: string;
  category: string;
  city: string;
  source: string;
  confidence: number;
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  verifiedPhone: boolean;
  verifiedEmail: boolean;
  scrapedAt: string;
};
```

## Search Flow

1. User submits `companyType`, `city`, and `count`
2. Backend validates input
3. Gemini expands the human query into provider-friendly search terms
4. Providers run in parallel with concurrency limits and timeouts
5. Results are normalized to the shared lead schema
6. Deduplication merges overlapping leads
7. Validation updates booleans and confidence
8. Response returns lead rows plus provider warnings and summary metadata

## Reliability Rules

- Every provider has a timeout
- Provider failures do not fail the full request
- Query expansion is optional and falls back to the raw query
- Deduplication is deterministic
- Validation is deterministic

## Testing Strategy

- Unit tests for validation and deduplication
- Unit tests for orchestrator fallback behavior
- Backend route test for `/api/search`
- Frontend component tests for search state and results rendering
- Build verification for both apps

## Delivery Order

1. Scaffold monorepo and shared conventions
2. Implement backend types, validation, providers, and route
3. Implement frontend screens and state with real API wiring
4. Add export flow and search history
5. Run tests and build verification
