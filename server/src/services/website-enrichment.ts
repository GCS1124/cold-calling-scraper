import * as cheerio from 'cheerio';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import type { Lead } from '../types/lead';
import type { ProviderWarning } from '../types/search';
import { httpClient } from '../utils/http-client';

const blockedPattern = /access denied|forbidden|captcha|cloudflare|attention required|blocked/i;
const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const phonePattern = /\+?1?[\s.(\-]*\d{3}[\s.)\-]*\d{3}[\s.\-]*\d{4}/g;
const socialHosts = new Set([
  'facebook.com',
  'www.facebook.com',
  'instagram.com',
  'www.instagram.com',
  'linkedin.com',
  'www.linkedin.com',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'tiktok.com',
  'www.tiktok.com',
  'yelp.com',
  'www.yelp.com',
]);

const maxPages = 12;
const maxDepth = 2;

const normalizeUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const normalizePhone = (value: string) => {
  const parsed = parsePhoneNumberFromString(value, 'US');
  if (!parsed?.isValid() || parsed.country !== 'US') {
    return '';
  }

  return parsed.formatInternational().replace(/-/g, ' ');
};

const extractPhones = (value: string) =>
  [...new Set((value.match(phonePattern) ?? []).map(normalizePhone).filter(Boolean))];

const parseJsonLdContacts = (html: string) => {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const addresses = new Set<string>();

  const scriptPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const payload = match[1]?.trim();
    if (!payload) {
      continue;
    }

    try {
      const parsed = JSON.parse(payload);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const entries = Array.isArray(item?.['@graph']) ? item['@graph'] : [item];
        for (const entry of entries) {
          if (typeof entry?.email === 'string') {
            emails.add(entry.email.toLowerCase());
          }
          if (typeof entry?.telephone === 'string') {
            const phone = normalizePhone(entry.telephone);
            if (phone) {
              phones.add(phone);
            }
          }
          const jsonLdAddress = entry?.address;
          if (typeof jsonLdAddress === 'string' && jsonLdAddress.trim()) {
            addresses.add(jsonLdAddress.trim());
          } else if (jsonLdAddress && typeof jsonLdAddress === 'object') {
            const parts = [
              jsonLdAddress.streetAddress,
              jsonLdAddress.addressLocality,
              jsonLdAddress.addressRegion,
              jsonLdAddress.postalCode,
            ]
              .map((part) => part?.trim())
              .filter(Boolean);
            if (parts.length) {
              addresses.add(parts.join(', '));
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return { emails: [...emails], phones: [...phones], addresses: [...addresses] };
};

const sameHost = (base: URL, candidate: URL) =>
  candidate.hostname === base.hostname || candidate.hostname === `www.${base.hostname}`;

const isContactPath = (candidate: URL) =>
  /contact|about|team|services|locations|support|privacy|staff|footer/i.test(
    `${candidate.pathname} ${candidate.search}`,
  );

export const extractContactDetailsFromHtml = (html: string) => {
  const $ = cheerio.load(html);
  const text = $('body')
    .find('*')
    .contents()
    .map((_index, node) => (node.type === 'text' ? $(node).text() : ''))
    .get()
    .join(' ');
  const emails = new Set<string>();
  const phones = new Set<string>();
  const addresses = new Set<string>();

  $('a[href^="mailto:"]').each((_index, element) => {
    const value = ($(element).attr('href') ?? '').replace(/^mailto:/i, '').trim().toLowerCase();
    if (value) {
      emails.add(value);
    }
  });

  $('a[href^="tel:"]').each((_index, element) => {
    const value = normalizePhone((($(element).attr('href') ?? '').replace(/^tel:/i, '').trim()));
    if (value) {
      phones.add(value);
    }
  });

  $('address, [itemprop="streetAddress"], [itemprop="addressLocality"], [itemprop="addressRegion"], [itemprop="postalCode"]').each(
    (_index, element) => {
      const value = $(element).text().replace(/\s+/g, ' ').trim();
      if (value) {
        addresses.add(value);
      }
    },
  );

  for (const email of text.match(emailPattern) ?? []) {
    emails.add(email.toLowerCase());
  }

  for (const phone of extractPhones(text)) {
    phones.add(phone);
  }

  const jsonLd = parseJsonLdContacts(html);
  for (const email of jsonLd.emails) {
    emails.add(email);
  }
  for (const phone of jsonLd.phones) {
    phones.add(phone);
  }
  for (const address of jsonLd.addresses) {
    addresses.add(address);
  }

  return {
    emails: [...emails],
    phones: [...phones],
    addresses: [...addresses],
  };
};

const selectBestEmail = (emails: string[], domainHint: string) =>
  [...emails].sort((left, right) => {
    const leftScore = Number(left.endsWith(`@${domainHint}`)) * 2 + Number(!left.startsWith('info@'));
    const rightScore =
      Number(right.endsWith(`@${domainHint}`)) * 2 + Number(!right.startsWith('info@'));
    return rightScore - leftScore;
  })[0] ?? '';

const getInternalLinks = (html: string, currentUrl: URL, origin: URL) => {
  const $ = cheerio.load(html);
  const links = new Set<string>();

  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) {
      return;
    }

    try {
      const candidate = new URL(href, currentUrl);
      if (!sameHost(origin, candidate)) {
        return;
      }
      if (!/^https?:$/i.test(candidate.protocol)) {
        return;
      }
      if (!isContactPath(candidate)) {
        return;
      }
      candidate.hash = '';
      links.add(candidate.toString());
    } catch {
      return;
    }
  });

  return [...links];
};

export const enrichLeadFromWebsite = async (
  lead: Lead,
): Promise<{ lead: Lead; warnings: ProviderWarning[] }> => {
  if (lead.rejectionReason === 'blocked_website') {
    return { lead, warnings: [] };
  }

  const website = normalizeUrl(lead.website ?? '');
  if (!website) {
    return { lead, warnings: [] };
  }

  const origin = new URL(website);
  if (socialHosts.has(origin.hostname)) {
    return { lead, warnings: [] };
  }

  const queue = [{ url: website, depth: 0 }];
  const visited = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const addresses = new Set<string>();
  const warnings: ProviderWarning[] = [];

  while (queue.length && visited.size < maxPages) {
    const current = queue.shift();
    if (!current || visited.has(current.url) || current.depth > maxDepth) {
      continue;
    }

    visited.add(current.url);

    try {
      const response = await httpClient.get<string>(current.url, {
        timeout: 8000,
        responseType: 'text',
        headers: {
          'User-Agent': 'LeadFinderPro/1.0 (US-only enrichment)',
          Accept: 'text/html,application/xhtml+xml',
        },
        validateStatus: () => true,
      });

      const contentType = String(response.headers['content-type'] ?? '');
      if (response.status >= 400 || blockedPattern.test(response.data)) {
        return {
          lead: {
            ...lead,
            crawlAttempts: visited.size,
            rejectionReason: lead.rejectionReason ?? 'blocked_website',
          },
          warnings: [],
        };
      }

      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        warnings.push({
          providerId: 'website-crawl',
          providerName: 'Website Crawl',
          message: `${current.url} is not an HTML page.`,
        });
        continue;
      }

      const extracted = extractContactDetailsFromHtml(response.data);
      extracted.emails.forEach((email) => emails.add(email));
      extracted.phones.forEach((phone) => phones.add(phone));
      extracted.addresses.forEach((address) => addresses.add(address));

      for (const link of getInternalLinks(response.data, new URL(current.url), origin)) {
        if (!visited.has(link) && queue.length + visited.size < maxPages) {
          queue.push({ url: link, depth: current.depth + 1 });
        }
      }
    } catch {
      return {
        lead: {
          ...lead,
          crawlAttempts: visited.size,
          rejectionReason: lead.rejectionReason ?? 'blocked_website',
        },
        warnings: [],
      };
    }
  }

  const domainHint = origin.hostname.replace(/^www\./, '');
  const email = selectBestEmail([...emails], domainHint) || lead.email || '';
  const phone = [...phones][0] || lead.mobile || '';
  const address = [...addresses][0] || lead.address || '';
  const improved = Boolean(
    (email && email !== lead.email) ||
      (phone && phone !== lead.mobile) ||
      (address && address !== lead.address),
  );

  return {
    lead: {
      ...lead,
      email,
      mobile: phone,
      address,
      website,
      crawlAttempts: visited.size,
      source: improved && !lead.source.includes('Website Crawl') ? `${lead.source}, Website Crawl` : lead.source,
    },
    warnings,
  };
};
