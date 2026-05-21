import axios from 'axios';
import * as cheerio from 'cheerio';

import type { Lead } from '../types/lead';
import type { LeadProvider } from './provider';

const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const isBlockedResponse = (status: number, body: string) =>
  status === 403 || /access denied|forbidden|captcha|blocked|unusual traffic/i.test(body);

export const yelpProvider: LeadProvider = {
  id: 'yelp',
  name: 'Yelp',
  async fetchLeads({ query, request }) {
    const response = await axios.get<string>('https://www.yelp.com/search', {
      params: {
        find_desc: query,
        find_loc: `${request.city}, USA`,
      },
      headers: { 'User-Agent': userAgent },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (isBlockedResponse(response.status, response.data)) {
      throw new Error('Yelp blocked the request with a captcha or access challenge');
    }

    if (response.status >= 400) {
      throw new Error(`Yelp returned HTTP ${response.status}`);
    }

    const $ = cheerio.load(response.data);
    const cards = $('li[data-testid="serp-ia-card"], .businessName').slice(0, request.count);

    return cards
      .map((index, element) => {
        const scope = $(element).is('li') ? $(element) : $(element).closest('li');
        const name =
          scope.find('a[href*="/biz/"]').first().text().trim() ||
          scope.find('.businessName').first().text().trim();

        if (!name) {
          return null;
        }

        const website = scope.find('a[href^="http"]').first().attr('href') || '';
        const address = scope.find('address, [data-testid="address"]').first().text().trim();

        const lead: Lead = {
          id: `yelp-${request.city}-${index}`,
          name,
          mobile: '',
          email: '',
          website,
          address,
          category: request.companyType,
          city: request.city,
          source: 'Yelp',
          confidence: 56,
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
