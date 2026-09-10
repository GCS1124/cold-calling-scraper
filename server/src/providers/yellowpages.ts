import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { Element } from 'domhandler';

import type { Lead } from '../types/lead';
import { normalizeContactPhone } from '../services/contact-evidence';
import { publicProviderAxiosLimits } from '../utils/provider-http-limits';
import {
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

const pickPhone = (scope: Cheerio<Element>, structuredPhone?: string) =>
  extractDirectoryPhone(
    scope.find('a[href^="tel:"]').first().attr('href'),
    scope.find('[data-phone], [data-testid*="phone"], .phone, .phones, [class*="phone"]').first().text(),
    structuredPhone,
    scope.text(),
  );

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
    const cards = $('.result, .v-card').slice(0, request.count);
    const structured = extractStructuredDirectoryEntities(
      $('script[type="application/ld+json"]').map((_, element) => $(element).text()).get(),
    );
    const observedAt = new Date().toISOString();

    return cards
      .map((index, element) => {
        const scope = $(element);
        const name = scope.find('.business-name, .n a, a.business-name').first().text().trim();
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
        );
        const contactEvidence = buildDirectoryPhoneEvidence({
          phone,
          sourceUrl: listingUrl,
          sourceName: 'Yellow Pages, Public Directory',
          observedAt,
        });

        const lead: Lead = {
          id: `yellow-pages-${request.city}-${index}`,
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
      .get()
      .filter((lead): lead is Lead => Boolean(lead));
  },
};
