import { chromium } from 'playwright';

import type { Lead } from '../types/lead';
import type { SearchRequest } from '../types/search';
import type { NormalizedUsLocation } from './us-location';

const blockedPattern =
  /unusual traffic|detected unusual traffic|sorry|captcha|automated queries|verify you are human/i;
const phonePattern = /\+?1?[\s.(\-]*\d{3}[\s.)\-]*\d{3}[\s.\-]*\d{4}/;

const normalizePhoneCandidate = (value: string) => value.trim();

const toAbsoluteUrl = (value: string) =>
  value.startsWith('http') ? value : `https://www.google.com${value}`;

const scoreLead = (lead: Lead) => {
  let score = 55;
  if (lead.mobile) score += 15;
  if (lead.website) score += 15;
  if (lead.website && lead.mobile) score += 10;
  return Math.min(score, 95);
};

type GoogleMapsCandidate = {
  name: string;
  listingUrl: string;
  phone?: string;
};

const extractListingCandidates = async (page: import('playwright').Page) =>
  page.$$eval('a[href*="/maps/place/"]', (anchors) => {
    const unique = new Map<string, { name: string; listingUrl: string; phone?: string }>();
    const phonePattern = /\+?1?[\s.(\-]*\d{3}[\s.)\-]*\d{3}[\s.\-]*\d{4}/;

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      const listingUrl = href.startsWith('http') ? href : `https://www.google.com${href}`;
      if (unique.has(listingUrl)) continue;

      const root =
        anchor.closest('[role="article"]') ??
        anchor.closest('div[role="link"]') ??
        anchor.parentElement;
      const text = root?.textContent?.trim() ?? anchor.textContent?.trim() ?? '';
      const phoneMatch = text.match(phonePattern)?.[0]?.trim();
      const name = anchor.getAttribute('aria-label')?.trim() || anchor.textContent?.trim() || '';

      if (!name) continue;

      unique.set(listingUrl, {
        name,
        listingUrl,
        phone: phoneMatch || undefined,
      });
    }

    return [...unique.values()];
  });

const scrapeListingDetails = async (
  browser: import('playwright').Browser,
  candidate: GoogleMapsCandidate,
  request: SearchRequest,
  locationLabel: string,
): Promise<Lead> => {
  const page = await browser.newPage();

  try {
    await page.goto(candidate.listingUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const body = (await page.textContent('body')) ?? '';
    if (blockedPattern.test(body)) {
      return {
        id: `google-${Buffer.from(candidate.listingUrl).toString('base64').slice(0, 24)}`,
        name: candidate.name,
        mobile: candidate.phone ?? '',
        email: '',
        website: '',
        address: '',
        category: request.companyType,
        city: locationLabel,
        source: 'Google Maps',
        confidence: 45,
        sourceScore: 90,
        listingUrl: candidate.listingUrl,
        qualified: false,
        rejectionReason: 'blocked_google',
        hasEmail: false,
        hasPhone: false,
        hasWebsite: false,
        verifiedPhone: false,
        verifiedEmail: false,
        scrapedAt: new Date().toISOString(),
      };
    }

    const scraped = await page.evaluate(() => {
      const name =
        document.querySelector('h1')?.textContent?.trim() ??
        document.querySelector('[role="main"] h1')?.textContent?.trim() ??
        '';
      const website =
        (document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null)?.href ??
        (document.querySelector('a[aria-label^="Website:"]') as HTMLAnchorElement | null)?.href ??
        '';
      const phoneButton =
        document.querySelector('button[data-item-id^="phone:tel:"]') ??
        document.querySelector('button[aria-label^="Phone:"]') ??
        document.querySelector('a[href^="tel:"]');
      const phone =
        phoneButton?.getAttribute('data-item-id')?.replace(/^phone:tel:/, '') ??
        phoneButton?.getAttribute('aria-label')?.replace(/^Phone:\s*/i, '') ??
        phoneButton?.textContent?.trim() ??
        '';

      return {
        name,
        website,
        phone,
      };
    });

    const lead: Lead = {
      id: `google-${Buffer.from(candidate.listingUrl).toString('base64').slice(0, 24)}`,
      name: scraped.name || candidate.name,
      mobile: normalizePhoneCandidate(scraped.phone || candidate.phone || ''),
      email: '',
      website: scraped.website || '',
      address: '',
      category: request.companyType,
      city: locationLabel,
      source: 'Google Maps',
      confidence: 0,
      sourceScore: 90,
      listingUrl: candidate.listingUrl,
      qualified: false,
      hasEmail: false,
      hasPhone: false,
      hasWebsite: false,
      verifiedPhone: false,
      verifiedEmail: false,
      scrapedAt: new Date().toISOString(),
    };

    lead.confidence = scoreLead(lead);
    return lead;
  } finally {
    await page.close();
  }
};

export const discoverUsLeadsFromGoogleMaps = async ({
  request,
  location,
}: {
  request: SearchRequest;
  location: NormalizedUsLocation;
}): Promise<Lead[]> => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  });

  try {
    const maxResults = Math.min(Math.max(Math.ceil(request.count / 2), 18), 36);
    const query = `${request.companyType} in ${location.label}`;
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const acceptButton = page.locator('button:has-text("Accept all")').first();
    if (await acceptButton.isVisible().catch(() => false)) {
      await acceptButton.click().catch(() => undefined);
    }

    await page.waitForTimeout(1500);

    const body = (await page.textContent('body')) ?? '';
    if (blockedPattern.test(body) || /\/sorry\//i.test(page.url())) {
      throw new Error('Google Maps blocked the request with a CAPTCHA or traffic challenge');
    }

    const feed = page.locator('[role="feed"]').first();
    const candidates = new Map<string, GoogleMapsCandidate>();
    let stagnantRounds = 0;

    while (candidates.size < maxResults && stagnantRounds < 4) {
      const before = candidates.size;
      for (const candidate of await extractListingCandidates(page)) {
        if (!candidates.has(candidate.listingUrl)) {
          candidates.set(candidate.listingUrl, candidate);
        }
      }

      if (candidates.size === before) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
      }

      if ((await feed.count()) > 0) {
        await feed.evaluate((node) => {
          node.scrollBy(0, node.clientHeight * 1.5);
        });
      } else {
        await page.mouse.wheel(0, 3000);
      }
      await page.waitForTimeout(800);
    }

    const listingCandidates = [...candidates.values()].slice(0, maxResults);
    const detailBrowser = browser;
    const concurrency = 4;
    const results: Lead[] = [];

    for (let index = 0; index < listingCandidates.length; index += concurrency) {
      const chunk = listingCandidates.slice(index, index + concurrency);
      const leads = await Promise.all(
        chunk.map((candidate) =>
          scrapeListingDetails(detailBrowser, candidate, request, location.label),
        ),
      );
      results.push(...leads);
    }

    return results;
  } finally {
    await page.close();
    await browser.close();
  }
};
