import axios from 'axios';
import * as cheerio from 'cheerio';

import type { Lead } from '../types/lead';
import type { LeadProvider } from './provider';

const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

export const justDialProvider: LeadProvider = {
  id: 'justdial',
  name: 'JustDial',
  async fetchLeads({ request }) {
    const url = `https://www.justdial.com/${encodeURIComponent(request.city)}/${encodeURIComponent(request.companyType)}`;
    const response = await axios.get<string>(url, {
      headers: { 'User-Agent': userAgent },
      timeout: 10000,
      validateStatus: (status) => status < 500,
    });

    const $ = cheerio.load(response.data);
    const cards = $('li, article, .resultbox_info').slice(0, request.count);

    return cards
      .map((index, element) => {
        const name = $(element).find('h2, h3, .lng_cont_name').first().text().trim();
        if (!name) {
          return null;
        }

        const phone =
          $(element).find('a[href^="tel:"]').first().text().trim() ||
          $(element).find('[data-phone-number]').first().attr('data-phone-number') ||
          '';
        const website =
          $(element).find('a[href^="http"]').first().attr('href') ||
          $(element).find('[data-href]').first().attr('data-href') ||
          '';
        const address = $(element).find('address, .cont_fl_addr').first().text().trim();

        const lead: Lead = {
          id: `justdial-${request.city}-${index}`,
          name,
          mobile: phone,
          email: '',
          website,
          address,
          category: request.companyType,
          city: request.city,
          source: 'JustDial',
          confidence: 52,
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
