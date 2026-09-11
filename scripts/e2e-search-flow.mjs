import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { webkit } from 'playwright';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5174/search';
const shouldStartDevServer = !process.env.E2E_BASE_URL;
let devServer;

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const waitForDevServer = async () => {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Vite may still be starting alongside the API process.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${baseUrl}`);
};

const makeLead = (mode, index = 1) => ({
  id: `e2e-${mode}-${index}`,
  name: `${mode} Public Lead`,
  headline: mode === 'ai' ? 'Owner at Austin Public Business' : undefined,
  organizationName: 'Austin Public Business',
  decisionMakerName: `${mode} Decision Maker`,
  decisionMakerRole: mode === 'ai' ? 'Owner' : 'Principal',
  decisionMakerSourceUrl: 'https://public-business.example/about',
  mobile: '+1 512 555 0101',
  email: mode === 'ai' ? 'hello@public-business.example' : '',
  website: 'https://public-business.example',
  contactSourceUrl: 'https://public-business.example/contact',
  decisionMakerPhonePair: {
    status: 'paired',
    phoneAssociation: 'business',
    phoneSourceUrl: 'https://public-business.example/contact',
    phoneSourceName: 'Public website contact page',
    personSourceUrl: 'https://public-business.example/about',
  },
  listingUrl:
    mode === 'ai'
      ? 'https://www.linkedin.com/in/public-business-owner'
      : 'https://www.google.com/maps/search/?api=1&query=Public%20Lead',
  address: 'Austin, TX',
  category: 'HVAC contractor',
  city: 'Austin, TX',
  source: mode === 'ai'
    ? 'Public LinkedIn, Public Profile'
    : 'Google Places',
  publicSocialLinks: mode === 'ai'
    ? [{ platform: 'LinkedIn', url: 'https://www.linkedin.com/in/public-business-owner' }]
    : undefined,
  confidence: 90,
  sourceScore: 90,
  hasEmail: mode === 'ai',
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: mode === 'ai',
  scrapedAt: new Date().toISOString(),
  quality: {
    version: 1, tier: 'supported', score: 60, freshness: 'recent',
    lastObservedAt: new Date().toISOString(), sourceKinds: ['business_website'],
    reasons: ['Valid US phone with public source evidence'],
    gaps: ['Personal ownership is unconfirmed'], nextAction: 'Review the public contact page',
    phone: { assessedValue: '+1 512 555 0101', formatValid: true, publiclyObserved: true, association: 'business', sourceUrls: ['https://public-business.example/contact'], lineType: 'unknown', reachability: 'not_checked' },
    email: { formatValid: mode === 'ai', publiclyObserved: mode === 'ai', sourceUrls: mode === 'ai' ? ['https://public-business.example/contact'] : [], mailbox: 'not_checked' },
  },
  evidence: [
    {
      sourceUrl: 'https://public-business.example/contact',
      sourceName: 'Public website contact page',
      claim: 'The public business website lists the validated phone number.',
      status: 'confirmed',
    },
  ],
});

const makeAiSourceSequenceLeads = () => {
  const pureLinkedIn = makeLead('ai', 1);

  return [
    {
      ...pureLinkedIn,
      id: 'e2e-ai-notarycafe',
      name: 'NotaryCafe Public Lead',
      source: 'NotaryCafe, Indexed Public Search',
      listingUrl: 'https://notarycafe.com/Sequence.Notary',
      contactSourceUrl: 'https://notarycafe.com/Sequence.Notary',
    },
    pureLinkedIn,
    {
      ...pureLinkedIn,
      id: 'e2e-ai-yelp',
      name: 'Yelp Public Lead',
      source: 'Yelp, Public Directory',
      listingUrl: 'https://www.yelp.com/biz/yelp-public-lead',
      contactSourceUrl: 'https://www.yelp.com/biz/yelp-public-lead',
      publicSocialLinks: undefined,
    },
    {
      ...pureLinkedIn,
      id: 'e2e-ai-yellow',
      name: 'Yellow Pages Public Lead',
      source: 'Yellow Pages, Public Directory',
      listingUrl: 'https://www.yellowpages.com/austin-tx/yellow-pages-public-lead',
      contactSourceUrl: 'https://www.yellowpages.com/austin-tx/yellow-pages-public-lead',
      publicSocialLinks: undefined,
    },
    {
      ...pureLinkedIn,
      id: 'e2e-ai-generic-listing',
      name: 'Generic Public Listing Lead',
      source: 'OpenStreetMap, Public Business Listings',
      listingUrl: 'https://www.openstreetmap.org/node/1001',
      contactSourceUrl: 'https://www.openstreetmap.org/node/1001',
      decisionMakerSourceUrl: undefined,
      publicSocialLinks: undefined,
      evidence: [{
        sourceUrl: 'https://www.openstreetmap.org/node/1001',
        sourceName: 'OpenStreetMap listing',
        claim: 'The public listing exposes the business route.',
        status: 'confirmed',
      }],
    },
    {
      ...pureLinkedIn,
      id: 'e2e-ai-gemini',
      name: 'Gemini Public Lead',
      source: 'Gemini, Grounded Public Search',
      listingUrl: 'https://gemini-public.example/candidate',
      contactSourceUrl: 'https://gemini-public.example/candidate',
      publicSocialLinks: undefined,
    },
    {
      ...pureLinkedIn,
      id: 'e2e-ai-google',
      name: 'Google Places Public Lead',
      source: 'Google Places',
      listingUrl: 'https://www.google.com/maps/place/google-places-public-lead',
      contactSourceUrl: 'https://www.google.com/maps/place/google-places-public-lead',
      publicSocialLinks: undefined,
    },
    {
      ...pureLinkedIn,
      id: 'e2e-ai-website',
      name: 'Public Website Enrichment Lead',
      source: 'Public Website Enrichment',
      listingUrl: 'https://public-business.example/about',
      contactSourceUrl: 'https://public-business.example/contact',
      decisionMakerSourceUrl: 'https://public-business.example/about',
      publicSocialLinks: undefined,
    },
    {
      ...pureLinkedIn,
      id: 'e2e-ai-fusion',
      name: 'AI LinkedIn Google Lead',
      source: 'Public LinkedIn, Google Business',
      listingUrl: 'https://www.linkedin.com/in/public-business-owner',
      contactSourceUrl: 'https://www.google.com/maps/place/public-business',
      publicSocialLinks: [{ platform: 'LinkedIn', url: 'https://www.linkedin.com/in/public-business-owner' }],
    },
  ];
};

const makeAiProviderCoverage = (stage) => {
  const isDiscovering = stage === 'discovering';
  const isEnriching = stage === 'enriching';
  const queued = (providerId, providerName, message) => ({
    providerId,
    providerName,
    status: 'configured',
    phase: 'queued',
    outcome: 'not_started',
    leadCount: 0,
    attemptedCount: 0,
    observedCount: 0,
    acceptedCount: 0,
    reviewCount: 0,
    deferredCount: 0,
    message,
  });

  return [
    {
      providerId: 'notarycafe-indexed-search',
      providerName: 'NotaryCafe, Indexed Public Search',
      status: 'returned',
      phase: 'completed',
      outcome: 'filtered',
      leadCount: 0,
      attemptedCount: 4,
      observedCount: 4,
      acceptedCount: 0,
      reviewCount: 1,
      deferredCount: 0,
      message: 'Indexed NotaryCafe completed: 0 matched / 4 screened for HVAC contractor; one candidate remains in review.',
    },
    isDiscovering
      ? {
          providerId: 'linkedin-public-search',
          providerName: 'Public LinkedIn Search',
          status: 'configured',
          phase: 'running',
          outcome: 'not_started',
          leadCount: 0,
          attemptedCount: 3,
          observedCount: 0,
          acceptedCount: 0,
          reviewCount: 0,
          deferredCount: 0,
          message: 'Deterministic public profile searches are running.',
        }
      : {
          providerId: 'linkedin-public-search',
          providerName: 'Public LinkedIn Search',
          status: 'returned',
          phase: 'completed',
          outcome: 'returned',
          leadCount: 1,
          attemptedCount: 8,
          observedCount: 2,
          acceptedCount: 1,
          reviewCount: 1,
          deferredCount: 0,
          message: 'Public LinkedIn profile signals were independently phone-qualified where possible.',
        },
    isDiscovering
      ? queued('yelp-public-directory', 'Yelp, Public Directory', 'Yelp is queued in its fair provider window.')
      : {
          providerId: 'yelp-public-directory',
          providerName: 'Yelp, Public Directory',
          status: 'returned',
          phase: 'completed',
          outcome: 'returned',
          leadCount: 1,
          attemptedCount: 4,
          observedCount: 2,
          acceptedCount: 1,
          reviewCount: 1,
          deferredCount: 0,
          message: 'Yelp location-checked directory results were deduplicated.',
        },
    isDiscovering
      ? queued('yellow-pages-public-directory', 'Yellow Pages, Public Directory', 'Yellow Pages is queued in its fair provider window.')
      : {
          providerId: 'yellow-pages-public-directory',
          providerName: 'Yellow Pages, Public Directory',
          status: 'returned',
          phase: 'completed',
          outcome: 'returned',
          leadCount: 1,
          attemptedCount: 4,
          observedCount: 2,
          acceptedCount: 1,
          reviewCount: 1,
          deferredCount: 0,
          message: 'Yellow Pages location-checked directory results were deduplicated.',
        },
    isDiscovering
      ? {
          providerId: 'public-business-listings',
          providerName: 'Public Business Listings',
          status: 'configured',
          phase: 'queued',
          outcome: 'deferred',
          leadCount: 0,
          attemptedCount: 4,
          observedCount: 1,
          acceptedCount: 0,
          reviewCount: 1,
          deferredCount: 8,
          message: 'OpenStreetMap advanced a bounded spatial batch; eight boxes remain for durable continuation.',
        }
      : {
          providerId: 'public-business-listings',
          providerName: 'Public Business Listings',
          status: 'returned',
          phase: 'completed',
          outcome: 'returned',
          leadCount: 1,
          attemptedCount: 12,
          observedCount: 3,
          acceptedCount: 1,
          reviewCount: 2,
          deferredCount: 0,
          message: 'OpenStreetMap spatial continuation completed with partial public records preserved.',
        },
    isDiscovering
      ? queued('gemini-public-discovery', 'Gemini public discovery', 'One grounded public-research pass is queued after deterministic source preparation.')
      : {
          providerId: 'gemini-public-discovery',
          providerName: 'Gemini public discovery',
          status: 'partial',
          phase: 'degraded',
          outcome: 'rate_limited',
          leadCount: 0,
          attemptedCount: 1,
          observedCount: 0,
          acceptedCount: 0,
          reviewCount: 1,
          deferredCount: 0,
          message: 'Gemini capacity was rate limited; deterministic public results and review evidence were preserved.',
        },
    isDiscovering
      ? queued('google-places-ai', 'Google Business (GMB) listings', 'Google Business listing seeds are queued after the grounded pass.')
      : {
          providerId: 'google-places-ai',
          providerName: 'Google Business (GMB) listings',
          status: 'returned',
          phase: 'completed',
          outcome: 'returned',
          leadCount: 40,
          attemptedCount: 1,
          observedCount: 500,
          acceptedCount: 40,
          reviewCount: 12,
          deferredCount: 0,
          message: 'Google Business observed 500 de-duplicated listing seeds; the best 40 were accepted into the bounded public evidence pool.',
        },
    isDiscovering
      ? queued('public-website-enrichment', 'Public Website Enrichment', 'Public website enrichment is queued after source discovery.')
      : isEnriching
        ? {
            providerId: 'public-website-enrichment',
            providerName: 'Public Website Enrichment',
            status: 'configured',
            phase: 'running',
            outcome: 'not_started',
            leadCount: 0,
            attemptedCount: 3,
            observedCount: 3,
            acceptedCount: 0,
            reviewCount: 0,
            deferredCount: 2,
            message: 'Public website enrichment is resuming bounded domains.',
          }
        : {
            providerId: 'public-website-enrichment',
            providerName: 'Public Website Enrichment',
            status: 'partial',
            phase: 'degraded',
            outcome: 'timed_out',
            leadCount: 1,
            attemptedCount: 5,
            observedCount: 5,
            acceptedCount: 1,
            reviewCount: 2,
            deferredCount: 0,
            completedCount: 4,
            enrichedCount: 1,
            timedOutCount: 1,
            message: 'One public website timed out; completed profiles and review evidence were preserved.',
          },
    isDiscovering || isEnriching
      ? queued('linkedin-public-google-business-fusion', 'LinkedIn + Google Business fusion', 'Final strict corroboration waits for all source and website stages.')
      : {
          providerId: 'linkedin-public-google-business-fusion',
          providerName: 'LinkedIn + Google Business fusion',
          status: 'returned',
          phase: 'completed',
          outcome: 'returned',
          leadCount: 1,
          attemptedCount: 2,
          observedCount: 2,
          acceptedCount: 1,
          reviewCount: 1,
          deferredCount: 0,
          message: 'Final strict LinkedIn + Google Business fusion retained one corroborated business route.',
        },
  ];
};

const makeResponse = (mode, failed = false, stage = 'complete') => ({
  searchId: `e2e-${mode}-${failed ? 'failed' : 'complete'}`,
  leads: failed ? [] : mode === 'ai' ? makeAiSourceSequenceLeads() : [makeLead(mode)],
  reviewCandidates: !failed && mode === 'ai'
    ? [{
        id: 'e2e-gemini-review',
        providerId: 'gemini-public-discovery',
        providerName: 'Gemini public discovery',
        reason: 'missing_public_phone',
        reasonDetail: 'The grounded public reference did not expose independently validated public-phone evidence.',
        name: 'Gemini Review-Only Owner',
        organizationName: 'Austin Public Business',
        location: 'Austin, TX',
        reportedPhone: '+1 512 555 0199',
        sourceUrls: ['https://public-business.example/about'],
        discoveredAt: new Date().toISOString(),
      }]
    : [],
  meta: {
    query: `HVAC contractor in Austin, TX`,
    locationLabel: 'Austin, TX',
    researchDepth: mode === 'ai' ? 'pro' : 'verified',
    status: failed ? 'failed' : mode === 'ai' ? stage : 'complete',
    execution: mode === 'ai' && !failed
      ? {
          path: 'durable',
          pollable: true,
          resumable: true,
          startedAt: '2026-09-11T00:00:00.000Z',
          lastProgressAt: '2026-09-11T00:00:00.000Z',
          ...(stage === 'complete' ? { completedAt: '2026-09-11T00:00:03.000Z' } : {}),
        }
      : {
          path: 'stateless',
          pollable: false,
          resumable: false,
          startedAt: '2026-09-11T00:00:00.000Z',
          lastProgressAt: '2026-09-11T00:00:00.000Z',
          completedAt: '2026-09-11T00:00:00.000Z',
        },
    progress: {
      discovered: failed ? 0 : mode === 'ai' ? 9 : 1,
      enriched: failed ? 0 : mode === 'ai' ? 9 : 1,
      publicContactsFound: failed ? 0 : mode === 'ai' ? 9 : 1,
      publicQueriesAttempted: mode === 'ai' ? 9 : 1,
      publicProvidersChecked: mode === 'ai' ? 9 : 1,
      providerCoverage: mode === 'gmb'
        ? [{
            providerId: 'google-places',
            providerName: 'Google Places',
            status: 'returned',
            leadCount: 1,
          }, {
            providerId: 'yelp-public-directory',
            providerName: 'Yelp, Public Directory',
            status: 'returned',
            leadCount: 1,
          }, {
            providerId: 'yellow-pages-public-directory',
            providerName: 'Yellow Pages, Public Directory',
            status: 'partial',
            leadCount: 0,
          }]
        : makeAiProviderCoverage(stage),
      aiAssistance: mode === 'ai' ? (stage === 'discovering' ? 'enabled' : 'rate_limited') : undefined,
      totalCandidates: failed ? 0 : mode === 'ai' ? 9 : 1,
      requestedCount: 50,
      foundCount: failed ? 0 : mode === 'ai' ? 9 : 1,
      duplicatesRemoved: 0,
      currentSource: failed
        ? 'Failed'
        : mode === 'ai' && stage === 'discovering'
          ? 'AI public-source discovery'
          : mode === 'ai' && stage === 'enriching'
            ? 'Public website enrichment'
            : 'Complete',
      batchesCompleted: 1,
      estimatedRemaining: failed ? 50 : mode === 'ai' ? 41 : 49,
    },
    totals: {
      total: failed ? 0 : mode === 'ai' ? 9 : 1,
      withEmail: failed ? 0 : mode === 'ai' ? 9 : 0,
      withPhone: failed ? 0 : mode === 'ai' ? 9 : 1,
      withWebsite: failed ? 0 : mode === 'ai' ? 9 : 1,
    },
    providerWarnings: failed
      ? [{
          providerId: 'no-usable-results',
          providerName: 'Search validation',
          message: 'No usable public-phone leads were returned.',
          severity: 'error',
        }]
      : mode === 'ai'
        ? [{
            providerId: 'ai-mode-policy',
            providerName: 'AI mode',
            message: 'Free AI mode does not use paid databases.',
            severity: 'info',
          }, {
            providerId: 'notarycafe-indexed-search-brave',
            providerName: 'Brave Search',
            message: 'Brave Search was unavailable for part of the indexed NotaryCafe search.',
          }, {
            providerId: 'linkedin-search-brave',
            providerName: 'Brave Search',
            message: 'Brave Search was paused after repeated failures. Discovery continued with available fallback providers.',
          }]
        : [],
  },
});

const fillSearch = async (page, mode, locationMode) => {
  await page.goto(baseUrl);
  await page.getByRole('heading', { name: 'Build your lead list' }).waitFor();
  assert(await page.getByRole('button', { name: /^LinkedIn\b/i }).count() === 0, 'Standalone LinkedIn mode is still rendered');
  await page.getByRole('button', { name: new RegExp(`^${mode === 'ai' ? 'AI mode' : mode}`, 'i') }).click();
  await page.locator('input[list="company-type-options"]').fill('HVAC contractor');

  if (locationMode === 'cityState') {
    await page.getByRole('button', { name: /city \/ state/i }).click();
    await page.getByPlaceholder('Austin, Phoenix, Miami').fill('Austin');
    await page.locator('select').last().selectOption('TX');
  } else {
    await page.locator('select').first().selectOption('EST');
  }

  if (mode === 'ai') {
    await page.getByPlaceholder(/Find owner-led HVAC companies/i).fill(
      'Find owner-led HVAC companies with a publicly listed mobile number.',
    );
    await page.getByRole('button', { name: /^Pro\b/i }).click();
    await page.getByText('AI interpretation preview').waitFor();
  }

  await page.getByRole('button', { name: 'Find Leads' }).click();
};

const run = async () => {
  if (shouldStartDevServer) {
    devServer = spawn('npm', ['run', 'dev'], {
      cwd: repoDir,
      stdio: 'ignore',
      env: process.env,
    });
    await waitForDevServer();
  }

  const browser = await webkit.launch({ headless: true });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const inspectQuality = async (mode, expectedCount = 1, leadName = `${mode} Public Lead`) => {
    await page.getByRole('button', { name: `Inspect ${leadName}`, exact: true }).click();
    await page.getByText(`${mode} Decision Maker`, { exact: true }).first().waitFor();
    await page.getByText('Name + business phone', { exact: true }).first().waitFor();
    await page.getByText('Decision-maker + phone route', { exact: true }).first().waitFor();
    await page.getByRole('link', { name: 'Open public name source', exact: true }).waitFor();
    await page.getByRole('region', { name: `Contact evidence for ${leadName}` }).waitFor();
    await page.getByText('Line type, reachability, email delivery', { exact: true }).waitFor();
    assert(await page.getByRole('link', { name: 'Phone source 1', exact: true }).getAttribute('href') === 'https://public-business.example/contact', 'Phone evidence URL was not retained');
    await page.getByRole('button', { name: 'Needs review 0', exact: true }).click();
    assert(await page.getByRole('button', { name: new RegExp(`^(Inspect|Hide) ${leadName}$`) }).count() === 0, 'Quality filter did not hide the row');
    await page.getByRole('button', { name: `All public-phone leads ${expectedCount}`, exact: true }).click();
  };
  let aiFailureNext = false;
  let aiSnapshotIndex = 0;

  await page.route('**/api/health', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"status":"ok"}',
  }));

  await page.route('**/api/search', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    const mode = body.sourceMode ?? 'gmb';
    const failed = mode === 'ai' && aiFailureNext;
    if (failed) {
      aiFailureNext = false;
    }
    if (mode === 'ai' && !failed) {
      aiSnapshotIndex = 0;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeResponse(mode, failed, mode === 'ai' && !failed ? 'discovering' : 'complete')),
    });
  });

  await page.route('**/api/search/e2e-ai-complete', async (route) => {
    const stage = aiSnapshotIndex === 0 ? 'enriching' : 'complete';
    aiSnapshotIndex += 1;
    // Leave the first durable snapshot on screen long enough to verify its
    // queued/deferred wording before the next bounded tick arrives.
    await new Promise((resolve) => setTimeout(resolve, stage === 'enriching' ? 250 : 1_000));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeResponse('ai', false, stage)),
    });
  });

  try {
    await page.goto(baseUrl);
    const skipLink = page.getByRole('link', { name: 'Skip to lead finder workspace', exact: true });
    await skipLink.waitFor();
    assert(await skipLink.count() === 1, 'Skip link is missing');
    await page.getByRole('button', { name: /^AI mode/i }).click();
    await page.locator('input[list="company-type-options"]').fill('Notary Public');
    assert(await page.getByText('Notary priority route active', { exact: true }).count() === 1, 'Notary priority route is not surfaced in the form');

    await fillSearch(page, 'gmb', 'cityState');
    await page.getByRole('heading', { name: 'Discovery complete' }).waitFor();
    await page.getByText('GMB source coverage', { exact: true }).waitFor();
    assert(await page.getByText('gmb Public Lead').count() === 1, 'GMB lead was not rendered');
    await inspectQuality('gmb');

    await fillSearch(page, 'ai', 'cityState');
    await page.getByText(/Running bounded public-source stages/i).waitFor();
    await page.getByText('Deferred · 8 remaining', { exact: true }).waitFor();
    await page.getByText('Collecting contact details', { exact: true }).waitFor();
    await page.locator('[data-provider-id="public-website-enrichment"]').getByText('Checking', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Discovery complete' }).waitFor();
    await page.getByText('AI mode coverage', { exact: true }).waitFor();
    assert(await page.getByText('AI interpretation preview').count() === 1, 'AI preview is missing');
    assert(await page.getByText('Public Business Listings').count() >= 1, 'AI public listing coverage is missing');
    assert(await page.getByText(/Yelp, Public Directory/i).count() >= 1, 'AI Yelp coverage is missing');
    assert(await page.getByText(/Yellow Pages, Public Directory/i).count() >= 1, 'AI Yellow Pages coverage is missing');
    assert(await page.getByText(/LinkedIn \+ Google Business fusion/i).count() >= 2, 'Final fusion coverage is missing');
    const providerOrder = await page
      .locator('[aria-label="AI workflow provider status"] [data-provider-id]')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-provider-id')));
    assert(
      JSON.stringify(providerOrder) === JSON.stringify([
        'notarycafe-indexed-search',
        'linkedin-public-search',
        'yelp-public-directory',
        'yellow-pages-public-directory',
        'public-business-listings',
        'gemini-public-discovery',
        'google-places-ai',
        'public-website-enrichment',
        'linkedin-public-google-business-fusion',
      ]),
      `Provider display order is incorrect: ${providerOrder.join(', ')}`,
    );
    const workflowStatus = page.getByLabel('AI workflow provider status');
    await workflowStatus.getByText('0 matched / 4 screened · 1 review', { exact: true }).waitFor();
    await workflowStatus.getByText('Rate limited · 0 accepted · 1 review', { exact: true }).waitFor();
    await workflowStatus.getByText('500 observed · 40 accepted', { exact: true }).waitFor();
    await workflowStatus.getByText('Timed out · 1 accepted · 2 review', { exact: true }).waitFor();
    assert(await page.getByText('Provider notes', { exact: true }).count() === 1, 'Handled provider notes are not informational');
    assert(await page.getByText(/2 handled Brave Search status updates/i).count() === 1, 'Repeated search-engine notices were not consolidated');
    const aiRows = await page.locator('tbody tr').allTextContents();
    const requiredOrder = [
      'NotaryCafe Public Lead',
      'ai Public Lead',
      'Yelp Public Lead',
      'Yellow Pages Public Lead',
      'Generic Public Listing Lead',
      'Gemini Public Lead',
      'Google Places Public Lead',
      'Public Website Enrichment Lead',
      'AI LinkedIn Google Lead',
    ];
    let lastRowIndex = -1;
    for (const expectedLead of requiredOrder) {
      const rowIndex = aiRows.findIndex((row) => row.includes(expectedLead));
      assert(rowIndex > lastRowIndex, `AI source sequence is incorrect for ${expectedLead}`);
      lastRowIndex = rowIndex;
    }
    for (const priorityLabel of [
      '1 · NotaryCafe indexed evidence',
      '2 · Pure public LinkedIn evidence',
      '3 · Yelp public directory',
      '4 · Yellow Pages public directory',
      '5 · Generic public listings',
      '6 · Gemini public research',
      '7 · Google Business listings',
      '8 · Public website enrichment',
      '9 · LinkedIn + Google Business fusion',
    ]) {
      const escapedLabel = priorityLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert(await page.locator('tbody').getByText(new RegExp(`^${escapedLabel}$`, 'i')).count() === 1, `Missing visible source tier: ${priorityLabel}`);
    }
    const reviewQueue = page.getByRole('region', { name: 'Unified review queue' });
    await reviewQueue.waitFor();
    assert(await reviewQueue.getByText('Export gate enforced', { exact: true }).count() === 1, 'Review export gate is missing');
    await reviewQueue.getByLabel('Filter review queue by provider').selectOption('gemini-public-discovery');
    await reviewQueue.getByLabel('Filter review queue by reason').selectOption('missing_public_phone');
    assert(await reviewQueue.getByText('Gemini Review-Only Owner', { exact: true }).count() === 1, 'Review-only public candidate is missing');
    await inspectQuality('ai', 9, 'NotaryCafe Public Lead');
    if (process.env.E2E_ARTIFACT_DIR) {
      await mkdir(process.env.E2E_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.E2E_ARTIFACT_DIR, 'quality-desktop.png'), fullPage: true });
    }

    await page.getByRole('button', { name: /download excel/i }).click();
    await page.getByText('Download 9 leads', { exact: true }).waitFor();
    assert(
      await page.getByRole('dialog').getByText('Gemini Review-Only Owner', { exact: true }).count() === 0,
      'Review-only candidate leaked into the export modal',
    );
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download file' }).click();
    const excelDownload = await downloadPromise;
    assert(excelDownload.suggestedFilename().endsWith('.xlsx'), 'Excel export did not produce an .xlsx file');

    await page.getByRole('button', { name: /download excel/i }).click();
    await page.getByRole('combobox').last().selectOption('csv');
    const csvDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download file' }).click();
    const csvDownload = await csvDownloadPromise;
    assert(csvDownload.suggestedFilename().endsWith('.csv'), 'CSV export did not produce a .csv file');

    aiFailureNext = true;
    await fillSearch(page, 'ai', 'timezone');
    await page.getByRole('heading', { name: 'Search failed' }).waitFor();
    await page.getByRole('button', { name: 'Try free search again' }).click();
    await page.getByRole('heading', { name: 'Discovery complete' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await fillSearch(page, 'ai', 'cityState');
    await page.getByRole('heading', { name: 'Discovery complete' }).waitFor();
    await inspectQuality('ai', 9, 'NotaryCafe Public Lead');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile page overflows horizontally');
    assert(await page.getByRole('link', { name: 'Open search history', exact: true }).count() === 1, 'Mobile history navigation lost its accessible name');
    assert(await page.getByRole('link', { name: 'Sign in', exact: true }).count() === 1, 'Mobile auth navigation lost its accessible name');
    const evidenceBox = await page.getByRole('region', { name: 'Contact evidence for NotaryCafe Public Lead' }).boundingBox();
    assert(evidenceBox && evidenceBox.width < 390, 'Contact evidence panel is clipped on mobile');
    const modeBox = await page.getByRole('button', { name: /^AI mode/i }).boundingBox();
    assert(modeBox && modeBox.x + modeBox.width <= 390, 'Source selector is clipped on mobile');
    if (process.env.E2E_ARTIFACT_DIR) {
      await page.screenshot({ path: path.join(process.env.E2E_ARTIFACT_DIR, 'quality-mobile.png'), fullPage: true });
      await page.getByRole('region', { name: 'Contact evidence for NotaryCafe Public Lead' }).screenshot({ path: path.join(process.env.E2E_ARTIFACT_DIR, 'quality-mobile-evidence.png') });
    }
    assert(browserErrors.length === 0, `Browser errors: ${browserErrors.join('; ')}`);
  } catch (error) {
    if (process.env.E2E_ARTIFACT_DIR) {
      await mkdir(process.env.E2E_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.E2E_ARTIFACT_DIR, 'quality-failure.png'), fullPage: true });
    }
    console.error((await page.locator('body').innerText()).slice(-4000));
    throw error;
  } finally {
    await browser.close();
  }
};

try {
  await run();
  console.log('Mocked browser acceptance passed: two modes, AI public-source fusion, contact evidence, quality filters, export, retry, mobile layout, and no page errors. This does not measure live provider yield.');
} finally {
  if (devServer && !devServer.killed) {
    devServer.kill('SIGTERM');
  }
}
