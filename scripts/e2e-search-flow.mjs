import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
  headline: mode === 'linkedin' ? 'Owner at Austin Public Business' : undefined,
  mobile: '+1 512 555 0101',
  email: mode === 'ai' ? 'hello@public-business.example' : '',
  website: 'https://public-business.example',
  contactSourceUrl: 'https://public-business.example/contact',
  listingUrl:
    mode === 'linkedin'
      ? 'https://www.linkedin.com/in/public-business-owner'
      : 'https://www.google.com/maps/search/?api=1&query=Public%20Lead',
  address: 'Austin, TX',
  category: 'HVAC contractor',
  city: 'Austin, TX',
  source: mode === 'linkedin' ? 'LinkedIn, Public Profile' : mode === 'ai' ? 'OpenStreetMap' : 'Google Places',
  confidence: 90,
  sourceScore: 90,
  hasEmail: mode === 'ai',
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: mode === 'ai',
  scrapedAt: new Date().toISOString(),
  evidence: [
    {
      sourceUrl: 'https://public-business.example/contact',
      sourceName: 'Public website contact page',
      claim: 'The public business website lists the validated phone number.',
      status: 'confirmed',
    },
  ],
});

const makeResponse = (mode, failed = false) => ({
  searchId: `e2e-${mode}-${failed ? 'failed' : 'complete'}`,
  leads: failed ? [] : [makeLead(mode)],
  meta: {
    query: `HVAC contractor in Austin, TX`,
    locationLabel: 'Austin, TX',
    researchDepth: mode === 'ai' ? 'pro' : 'verified',
    status: failed ? 'failed' : 'complete',
    progress: {
      discovered: failed ? 0 : 1,
      enriched: failed ? 0 : 1,
      publicContactsFound: failed ? 0 : 1,
      publicQueriesAttempted: mode === 'linkedin' ? 4 : 1,
      publicProvidersChecked: mode === 'linkedin' ? 4 : 1,
      providerCoverage: mode === 'ai' ? [{
        providerId: 'public-business-listings',
        providerName: 'Public Business Listings',
        status: 'returned',
        leadCount: 1,
      }] : undefined,
      aiAssistance: mode === 'ai' ? 'disabled' : undefined,
      totalCandidates: failed ? 0 : 1,
      requestedCount: 50,
      foundCount: failed ? 0 : 1,
      duplicatesRemoved: 0,
      currentSource: failed ? 'Failed' : 'Complete',
      batchesCompleted: 1,
      estimatedRemaining: failed ? 50 : 49,
    },
    totals: {
      total: failed ? 0 : 1,
      withEmail: failed ? 0 : Number(mode === 'ai'),
      withPhone: failed ? 0 : 1,
      withWebsite: failed ? 0 : 1,
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
          }]
        : [],
  },
});

const fillSearch = async (page, mode, locationMode) => {
  await page.goto(baseUrl);
  await page.getByRole('heading', { name: 'Build your lead list' }).waitFor();
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
  let linkedinFailureNext = false;

  await page.route('**/api/search', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    const mode = body.sourceMode ?? 'gmb';
    const failed = mode === 'linkedin' && linkedinFailureNext;
    if (failed) {
      linkedinFailureNext = false;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeResponse(mode, failed)),
    });
  });

  try {
    await fillSearch(page, 'gmb', 'cityState');
    await page.getByRole('heading', { name: 'Discovery complete' }).waitFor();
    assert(await page.getByText('gmb Public Lead').count() === 1, 'GMB lead was not rendered');

    await fillSearch(page, 'linkedin', 'timezone');
    await page.getByRole('heading', { name: 'Public LinkedIn discovery complete' }).waitFor();
    assert(await page.getByText('linkedin Public Lead').count() === 1, 'LinkedIn lead was not rendered');

    await fillSearch(page, 'ai', 'cityState');
    await page.getByRole('heading', { name: 'Discovery complete' }).waitFor();
    assert(await page.getByText('AI interpretation preview').count() === 1, 'AI preview is missing');
    assert(await page.getByText('Public Business Listings').count() === 1, 'AI public listing coverage is missing');

    await page.getByRole('button', { name: /download excel/i }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download file' }).click();
    await downloadPromise;

    linkedinFailureNext = true;
    await fillSearch(page, 'linkedin', 'timezone');
    await page.getByRole('heading', { name: 'Search failed' }).waitFor();
    await page.getByRole('button', { name: 'Try public search again' }).click();
    await page.getByRole('heading', { name: 'Public LinkedIn discovery complete' }).waitFor();
  } finally {
    await browser.close();
  }
};

try {
  await run();
  console.log('Browser acceptance flow passed for GMB, LinkedIn, AI mode, export, and retry recovery.');
} finally {
  if (devServer && !devServer.killed) {
    devServer.kill('SIGTERM');
  }
}
