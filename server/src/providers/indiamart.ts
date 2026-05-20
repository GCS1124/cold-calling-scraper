import axios from 'axios';
import * as cheerio from 'cheerio';

import type { Lead } from '../types/lead';
import type { LeadProvider } from './provider';

const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

export const indiaMartProvider: LeadProvider = {
  id: 'indiamart',
  name: 'IndiaMART',
  async fetchLeads({ query, request }) {
    const response = await axios.get<string>('https://dir.indiamart.com/search.mp', {
      params: {
        ss: query,
        cq: request.city,
      },
      headers: { 'User-Agent': userAgent },
      timeout: 10000,
      validateStatus: (status) => status < 500,
    });

    const $ = cheerio.load(response.data);
    const cards = $('.cardbody, .r-cl, .f-div').slice(0, request.count);

    return cards
      .map((index, element) => {
        const name = $(element).find('h2, h3, .pn').first().text().trim();
        if (!name) {
          return null;
        }

        const website = $(element).find('a[href^="http"]').first().attr('href') || '';
        const address = $(element).find('.city, .lc, .clg').first().text().trim();
        const phone = $(element).find('a[href^="tel:"]').first().text().trim();

        const lead: Lead = {
          id: `indiamart-${request.city}-${index}`,
          name,
          mobile: phone,
          email: '',
          website,
          address,
          category: request.companyType,
          city: request.city,
          source: 'IndiaMART',
          confidence: 55,
          qualified: false,
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
