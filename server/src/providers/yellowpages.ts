import axios from 'axios';
import * as cheerio from 'cheerio';

import type { Lead } from '../types/lead';
import type { LeadProvider } from './provider';

const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const isBlockedResponse = (status: number, body: string) =>
  status === 403 || /attention required|cloudflare|access denied|forbidden|captcha|blocked/i.test(body);

export const yellowPagesProvider: LeadProvider = {
  id: 'yellow-pages',
  name: 'Yellow Pages',
  async fetchLeads({ query, request }) {
    const response = await axios.get<string>('https://www.yellowpages.com/search', {
      params: {
        search_terms: query,
        geo_location_terms: request.city,
      },
      headers: { 'User-Agent': userAgent },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (isBlockedResponse(response.status, response.data)) {
      throw new Error('Yellow Pages blocked the request with a Cloudflare or access challenge');
    }

    if (response.status >= 400) {
      throw new Error(`Yellow Pages returned HTTP ${response.status}`);
    }

    const $ = cheerio.load(response.data);
    const cards = $('.result, .v-card').slice(0, request.count);

    return cards
      .map((index, element) => {
        const name = $(element).find('.business-name, .n a').first().text().trim();
        if (!name) {
          return null;
        }

        const phone = $(element).find('.phones').first().text().trim();
        const website =
          $(element).find('.track-visit-website').first().attr('href') ||
          $(element).find('a[href^="http"]').first().attr('href') ||
          '';
        const address = $(element).find('.street-address, .adr').first().text().trim();

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
          confidence: 60,
          hasEmail: false,
          hasPhone: false,
          hasWebsite: false,
          verifiedPhone: false,
          verifiedEmail: false,
          scrapedAt: new Date().toISOString(),
        };

        return lead;
      })
      .get()
      .filter((lead): lead is Lead => Boolean(lead));
  },
};
