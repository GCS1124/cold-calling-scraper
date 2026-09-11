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
  status === 403 || /attention required|cloudflare|access denied|forbidden|captcha|blocked/i.test(body);

const yellowPagesSearchUrl = 'https://www.yellowpages.com/search';
const yellowPagesBlockedHosts = ['yellowpages.com'];

const pickPhone = (scope: Cheerio<AnyNode>, structuredPhone?: string) =>
  extractDirectoryPhone(
    scope.find('a[href^="tel:"]').first().attr('href'),
    scope.find('[data-phone], [data-testid*="phone"], .phone, .phones, [class*="phone"]').first().text(),
    structuredPhone,
    scope.text(),
  );

const getYellowPagesCardElements = ($: CheerioAPI) => {
  const resultCards = $('.result')
    .filter((_, element) => $(element).parents('.result').length === 0)
    .toArray();
  const vCards = $('.v-card')
    .filter((_, element) => $(element).parents('.v-card').length === 0)
    .toArray();
  const fallback = resultCards.length
    ? resultCards
    : vCards.length
      ? vCards
      : $('.business-name').map((_, element) => {
          const root = $(element).closest('.result, .v-card, article, [role="article"]').first();
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

export const yellowPagesProvider: LeadProvider = {
  id: 'yellow-pages',
  name: 'Yellow Pages',
  async fetchLeads({ query, request, deadlineMs }) {
    const searchUrl = buildProviderSearchUrl(yellowPagesSearchUrl, {
      search_terms: query,
      geo_location_terms: request.city,
    });
    const response = await axios.get<string>(yellowPagesSearchUrl, {
      params: {
        search_terms: query,
        geo_location_terms: request.city,
      },
      headers: { 'User-Agent': userAgent },
      ...publicProviderAxiosLimits,
      timeout: Math.max(1, Math.min(10_000, deadlineMs ? deadlineMs - Date.now() : 10_000)),
      validateStatus: () => true,
    });

    const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    if (isBlockedResponse(response.status, body)) {
      throw new Error('Yellow Pages blocked the request with a Cloudflare or access challenge');
    }

    if (response.status >= 400) {
      throw new Error(`Yellow Pages returned HTTP ${response.status}`);
    }

    const $ = cheerio.load(body);
    const cards = getYellowPagesCardElements($);
    const structured = extractStructuredDirectoryEntities(
      $('script[type="application/ld+json"]').map((_, element) => $(element).text()).get(),
    );
    const observedAt = new Date().toISOString();

    const parsedLeads = cards
      .map((element) => {
        const scope = $(element);
        const name =
          scope.find('.business-name, .n a, a.business-name').first().text().trim() ||
          (scope.is('.business-name') ? scope.text().trim() : '');
        if (!name) {
          return null;
        }

        const structuredEntity = findStructuredDirectoryEntity(structured, name);
        const phone = pickPhone(scope, structuredEntity?.telephone) || normalizeContactPhone(
          structuredEntity?.telephone,
        );
        const website =
          [
            scope.find('.track-visit-website').first().attr('href'),
            ...scope.find('a[href]').map((_, link) => $(link).attr('href')).get(),
            structuredEntity?.url,
          ]
            .map((href) => toPublicAbsoluteUrl(href, yellowPagesSearchUrl, yellowPagesBlockedHosts))
            .find(Boolean) || '';
        const address = scope.find('.street-address, .adr, [class*="address"]').first().text().trim();
        const listingUrl = toProviderListingUrl(
          scope.find('a[href*="/biz/"], a[href*="/mip/"]').first().attr('href'),
          yellowPagesSearchUrl,
          /\/(?:biz|mip)\//i,
          searchUrl,
          yellowPagesBlockedHosts,
        );
        const contactEvidence = buildDirectoryPhoneEvidence({
          phone,
          sourceUrl: listingUrl,
          sourceName: 'Yellow Pages, Public Directory',
          observedAt,
        });

        const lead: Lead = {
          id: buildStableProviderLeadId('yellow-pages', [
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
          source: 'Yellow Pages',
          confidence: phone ? 66 : 60,
          sourceScore: 64,
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
