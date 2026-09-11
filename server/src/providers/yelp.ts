import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

import type { Lead } from '../types/lead';
import { normalizeContactPhone } from '../services/contact-evidence';
import { publicProviderAxiosLimits } from '../utils/provider-http-limits';
import {
  buildStableProviderLeadId,
  buildDirectoryPhoneEvidence,
  buildProviderSearchUrl,
  extractDirectoryPhone,
  extractStructuredDirectoryEntities,
  findStructuredDirectoryEntity,
  toProviderListingUrl,
  toPublicAbsoluteUrl,
} from './public-directory-utils';
import type { LeadProvider } from './provider';

const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const isBlockedResponse = (status: number, body: string) =>
  status === 403 || /access denied|forbidden|captcha|blocked|unusual traffic/i.test(body);

const yelpSearchUrl = 'https://www.yelp.com/search';
const yelpBlockedHosts = ['yelp.com'];

const pickPhone = (scope: Cheerio<AnyNode>, structuredPhone?: string) =>
  extractDirectoryPhone(
    scope.find('a[href^="tel:"]').first().attr('href'),
    scope.find('[data-phone], [data-testid*="phone"], .phone, .phones').first().text(),
    structuredPhone,
    scope.text(),
  );

const getYelpCardElements = ($: CheerioAPI) => {
  const preferred = $('[data-testid="serp-ia-card"]')
    .filter((_, element) => $(element).parents('[data-testid="serp-ia-card"]').length === 0)
    .toArray();
  const fallback = preferred.length
    ? preferred
    : $('.businessName').map((_, element) => {
        const root = $(element).closest('li, article, [role="article"]').first();
        return root.length ? root[0] : element;
      }).get();
  const seen = new Set<AnyNode>();

  return fallback.filter((element) => {
    if (!element || seen.has(element)) return false;
    seen.add(element);
    return true;
  });
};

const chooseBetterLead = (current: Lead, incoming: Lead) => {
  const score = (lead: Lead) =>
    Number(Boolean(lead.mobile)) * 4 +
    Number(Boolean(lead.website)) * 2 +
    Number(Boolean(lead.address));

  return score(incoming) > score(current) ? incoming : current;
};

export const yelpProvider: LeadProvider = {
  id: 'yelp',
  name: 'Yelp',
  async fetchLeads({ query, request, deadlineMs }) {
    const searchUrl = buildProviderSearchUrl(yelpSearchUrl, {
      find_desc: query,
      find_loc: `${request.city}, USA`,
    });
    const response = await axios.get<string>(yelpSearchUrl, {
      params: {
        find_desc: query,
        find_loc: `${request.city}, USA`,
      },
      headers: { 'User-Agent': userAgent },
      ...publicProviderAxiosLimits,
      timeout: Math.max(1, Math.min(10_000, deadlineMs ? deadlineMs - Date.now() : 10_000)),
      validateStatus: () => true,
    });

    const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    if (isBlockedResponse(response.status, body)) {
      throw new Error('Yelp blocked the request with a captcha or access challenge');
    }

    if (response.status >= 400) {
      throw new Error(`Yelp returned HTTP ${response.status}`);
    }

    const $ = cheerio.load(body);
    const cards = getYelpCardElements($);
    const structured = extractStructuredDirectoryEntities(
      $('script[type="application/ld+json"]').map((_, element) => $(element).text()).get(),
    );
    const observedAt = new Date().toISOString();

    const parsedLeads = cards
      .map((element) => {
        const scope = $(element);
        const name =
          scope.find('a[href*="/biz/"]').first().text().trim() ||
          scope.find('.businessName').first().text().trim() ||
          (scope.is('.businessName') ? scope.text().trim() : '');

        if (!name) {
          return null;
        }

        const structuredEntity = findStructuredDirectoryEntity(structured, name);
        const website =
          [...scope.find('a[href]').map((_, link) => $(link).attr('href')).get(), structuredEntity?.url]
            .map((href) => toPublicAbsoluteUrl(href, yelpSearchUrl, yelpBlockedHosts))
            .find(Boolean) || '';
        const address = scope.find('address, [data-testid="address"]').first().text().trim();
        const phone = pickPhone(scope, structuredEntity?.telephone) || normalizeContactPhone(
          structuredEntity?.telephone,
        );
        const listingUrl = toProviderListingUrl(
          scope.find('a[href*="/biz/"]').first().attr('href'),
          yelpSearchUrl,
          /\/biz\//i,
          searchUrl,
          yelpBlockedHosts,
        );
        const contactEvidence = buildDirectoryPhoneEvidence({
          phone,
          sourceUrl: listingUrl,
          sourceName: 'Yelp, Public Directory',
          observedAt,
        });

        const lead: Lead = {
          id: buildStableProviderLeadId('yelp', [
            listingUrl !== searchUrl ? listingUrl : undefined,
            name,
            phone,
            address,
            request.city,
          ]),
          name,
          mobile: phone,
          email: '',
          website,
          address,
          category: request.companyType,
          city: request.city,
          source: 'Yelp',
          confidence: phone ? 64 : 56,
          sourceScore: 62,
          listingUrl,
          contactSourceUrl: phone ? listingUrl : undefined,
          contactEvidence,
          hasEmail: false,
          hasPhone: Boolean(phone),
          hasWebsite: Boolean(website),
          verifiedPhone: Boolean(phone),
          verifiedEmail: false,
          scrapedAt: new Date().toISOString(),
        };

        return lead;
      })
      .filter((lead): lead is Lead => Boolean(lead));

    const deduped = new Map<string, Lead>();
    for (const lead of parsedLeads) {
      const key = lead.listingUrl && lead.listingUrl !== searchUrl
        ? `url:${lead.listingUrl.toLowerCase()}`
        : `record:${[lead.name, lead.mobile, lead.address]
            .map((value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' '))
            .join('|')}`;
      const previous = deduped.get(key);
      deduped.set(key, previous ? chooseBetterLead(previous, lead) : lead);
    }

    return [...deduped.values()].slice(0, request.count);
  },
};
