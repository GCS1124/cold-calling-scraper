import * as cheerio from 'cheerio';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import type { Lead } from '../types/lead';
import type { ProviderWarning } from '../types/search';
import { httpClient } from '../utils/http-client';

type CrawlPage = {
  url: string;
  depth: number;
  score: number;
};

type ExtractedContactDetails = {
  emails: string[];
  phones: string[];
  addresses: string[];
  socialUrls: string[];
};

const blockedPattern =
  /access denied|forbidden|captcha|cloudflare|attention required|blocked|bot detection|verify you are human|unusual traffic/i;

const emailPattern =
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const obfuscatedEmailPatterns = [
  /([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\)| at )\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)| dot )\s*([a-z]{2,})/gi,
  /([a-z0-9._%+-]+)\s+at\s+([a-z0-9.-]+)\s+dot\s+([a-z]{2,})/gi,
];

const phonePattern =
  /(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}(?:\s*(?:x|ext|extension)\s*\d{1,6})?/gi;

const maxPages = Number(process.env.WEBSITE_CRAWL_MAX_PAGES ?? 14);
const maxDepth = Number(process.env.WEBSITE_CRAWL_MAX_DEPTH ?? 2);
const requestTimeoutMs = Number(process.env.WEBSITE_CRAWL_TIMEOUT_MS ?? 8_000);
const maxHtmlBytes = Number(process.env.WEBSITE_CRAWL_MAX_HTML_BYTES ?? 1_500_000);

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
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'yelp.com',
  'www.yelp.com',
  'tripadvisor.com',
  'www.tripadvisor.com',
  'opentable.com',
  'www.opentable.com',
  'google.com',
  'www.google.com',
  'maps.google.com',
  'goo.gl',
]);

const ignoredFileExtensions = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.css',
  '.js',
  '.json',
  '.xml',
  '.zip',
  '.rar',
  '.7z',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

const badEmailDomains = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'email.com',
  'test.com',
  'localhost.com',
  'yourdomain.com',
  'sentry.io',
]);

const badEmailPrefixes = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'example',
  'test',
  'admin@example',
  'email',
  'name',
  'user',
];

const roleEmailPriority = [
  'contact',
  'hello',
  'info',
  'office',
  'support',
  'service',
  'sales',
  'appointments',
  'booking',
  'reception',
  'admin',
];

const normalizeUrl = (value: string) => {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  if (/^(mailto|tel|sms|javascript|data):/i.test(trimmed)) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    url.hash = '';

    if (!/^https?:$/i.test(url.protocol)) {
      return '';
    }

    return url.toString();
  } catch {
    return '';
  }
};

const canonicalizeUrl = (value: string) => {
  try {
    const url = new URL(value);
    url.hash = '';

    const removableParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'msclkid',
      'yclid',
    ];

    for (const param of removableParams) {
      url.searchParams.delete(param);
    }

    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return value;
  }
};

const getHostnameWithoutWww = (value: string) => {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
};

const isSocialHost = (hostname: string) => {
  const normalized = hostname.replace(/^www\./i, '').toLowerCase();

  return socialHosts.has(hostname.toLowerCase()) || socialHosts.has(normalized);
};

const isLikelyAssetUrl = (url: URL) => {
  const pathname = url.pathname.toLowerCase();

  for (const extension of ignoredFileExtensions) {
    if (pathname.endsWith(extension)) {
      return true;
    }
  }

  return false;
};

const sameHost = (base: URL, candidate: URL) => {
  const baseHost = base.hostname.replace(/^www\./i, '').toLowerCase();
  const candidateHost = candidate.hostname.replace(/^www\./i, '').toLowerCase();

  return baseHost === candidateHost;
};

const normalizeEmail = (value: string) => {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .trim();

  if (!cleaned || !emailPattern.test(cleaned)) {
    emailPattern.lastIndex = 0;
    return '';
  }

  emailPattern.lastIndex = 0;

  const [localPart, domain] = cleaned.split('@');

  if (!localPart || !domain) {
    return '';
  }

  if (badEmailDomains.has(domain)) {
    return '';
  }

  if (
    badEmailPrefixes.some((prefix) =>
      localPart === prefix || localPart.startsWith(`${prefix}.`) || localPart.startsWith(`${prefix}-`),
    )
  ) {
    return '';
  }

  if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(domain)) {
    return '';
  }

  return cleaned;
};

const normalizePhone = (value: string) => {
  const parsed = parsePhoneNumberFromString(value, 'US');

  if (!parsed?.isValid() || parsed.country !== 'US') {
    return '';
  }

  return parsed.formatInternational().replace(/-/g, ' ');
};

const extractPhones = (value: string) =>
  [
    ...new Set(
      (value.match(phonePattern) ?? [])
        .map(normalizePhone)
        .filter(Boolean),
    ),
  ];

const extractObfuscatedEmails = (text: string) => {
  const emails = new Set<string>();

  for (const pattern of obfuscatedEmailPatterns) {
    for (const match of text.matchAll(pattern)) {
      const local = match[1]?.trim();
      const domain = match[2]?.trim();
      const tld = match[3]?.trim();

      if (!local || !domain || !tld) {
        continue;
      }

      const email = normalizeEmail(`${local}@${domain}.${tld}`);

      if (email) {
        emails.add(email);
      }
    }
  }

  return [...emails];
};

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const flattenJsonLd = (value: unknown): unknown[] => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap(flattenJsonLd);
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const graph = objectValue['@graph'];

    if (Array.isArray(graph)) {
      return [objectValue, ...graph.flatMap(flattenJsonLd)];
    }

    return [objectValue];
  }

  return [];
};

const formatJsonLdAddress = (address: unknown) => {
  if (!address) return '';

  if (typeof address === 'string') {
    return address.replace(/\s+/g, ' ').trim();
  }

  if (typeof address !== 'object') {
    return '';
  }

  const jsonLdAddress = address as Record<string, unknown>;

  const parts = [
    jsonLdAddress.streetAddress,
    jsonLdAddress.addressLocality,
    jsonLdAddress.addressRegion,
    jsonLdAddress.postalCode,
  ]
    .map((part) => String(part ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return parts.join(', ');
};

const parseJsonLdContacts = (html: string): ExtractedContactDetails => {
  const $ = cheerio.load(html);
  const emails = new Set<string>();
  const phones = new Set<string>();
  const addresses = new Set<string>();
  const socialUrls = new Set<string>();

  $('script[type="application/ld+json"]').each((_index, element) => {
    const payload = $(element).text().trim();

    if (!payload) {
      return;
    }

    const parsed = safeJsonParse(payload);

    for (const entry of flattenJsonLd(parsed)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const objectEntry = entry as Record<string, unknown>;

      const email = normalizeEmail(String(objectEntry.email ?? ''));
      if (email) {
        emails.add(email);
      }

      const telephone = normalizePhone(String(objectEntry.telephone ?? ''));
      if (telephone) {
        phones.add(telephone);
      }

      const address = formatJsonLdAddress(objectEntry.address);
      if (address) {
        addresses.add(address);
      }

      const sameAs = objectEntry.sameAs;
      const sameAsValues = Array.isArray(sameAs) ? sameAs : [sameAs];

      for (const value of sameAsValues) {
        const normalized = normalizeUrl(String(value ?? ''));

        if (!normalized) {
          continue;
        }

        try {
          const url = new URL(normalized);
          if (isSocialHost(url.hostname)) {
            socialUrls.add(url.toString());
          }
        } catch {
          continue;
        }
      }
    }
  });

  return {
    emails: [...emails],
    phones: [...phones],
    addresses: [...addresses],
    socialUrls: [...socialUrls],
  };
};

const extractVisibleText = ($: cheerio.CheerioAPI) => {
  $('script, style, noscript, svg, canvas, iframe').remove();

  return $('body')
    .text()
    .replace(/\s+/g, ' ')
    .trim();
};

const extractAddressesFromHtml = ($: cheerio.CheerioAPI) => {
  const addresses = new Set<string>();

  const selectors = [
    'address',
    '[itemprop="address"]',
    '[itemprop="streetAddress"]',
    '[itemprop="addressLocality"]',
    '[itemprop="addressRegion"]',
    '[itemprop="postalCode"]',
    '[class*="address" i]',
    '[class*="location" i]',
    '[id*="address" i]',
    '[id*="location" i]',
  ];

  $(selectors.join(',')).each((_index, element) => {
    const value = $(element).text().replace(/\s+/g, ' ').trim();

    if (
      value &&
      value.length >= 12 &&
      value.length <= 240 &&
      /\b[A-Z]{2}\b|\b\d{5}(?:-\d{4})?\b/i.test(value)
    ) {
      addresses.add(value);
    }
  });

  return [...addresses];
};

const extractSocialUrlsFromHtml = ($: cheerio.CheerioAPI, currentUrl: URL) => {
  const socialUrls = new Set<string>();

  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');

    if (!href) {
      return;
    }

    try {
      const candidate = new URL(href, currentUrl);

      if (isSocialHost(candidate.hostname)) {
        candidate.hash = '';
        socialUrls.add(candidate.toString());
      }
    } catch {
      return;
    }
  });

  return [...socialUrls];
};

export const extractContactDetailsFromHtml = (
  html: string,
  pageUrl?: string,
): ExtractedContactDetails => {
  const $ = cheerio.load(html);
  const text = extractVisibleText($);
  const emails = new Set<string>();
  const phones = new Set<string>();
  const addresses = new Set<string>();
  const socialUrls = new Set<string>();

  $('a[href^="mailto:"]').each((_index, element) => {
    const value = normalizeEmail($(element).attr('href') ?? '');

    if (value) {
      emails.add(value);
    }
  });

  $('a[href^="tel:"]').each((_index, element) => {
    const value = normalizePhone(
      ($(element).attr('href') ?? '').replace(/^tel:/i, '').trim(),
    );

    if (value) {
      phones.add(value);
    }
  });

  for (const email of text.match(emailPattern) ?? []) {
    const normalized = normalizeEmail(email);

    if (normalized) {
      emails.add(normalized);
    }
  }

  for (const email of extractObfuscatedEmails(text)) {
    emails.add(email);
  }

  for (const phone of extractPhones(text)) {
    phones.add(phone);
  }

  for (const address of extractAddressesFromHtml($)) {
    addresses.add(address);
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

  for (const socialUrl of jsonLd.socialUrls) {
    socialUrls.add(socialUrl);
  }

  if (pageUrl) {
    try {
      for (const socialUrl of extractSocialUrlsFromHtml($, new URL(pageUrl))) {
        socialUrls.add(socialUrl);
      }
    } catch {
      // ignore invalid page URL
    }
  }

  return {
    emails: [...emails],
    phones: [...phones],
    addresses: [...addresses],
    socialUrls: [...socialUrls],
  };
};

const getEmailScore = (email: string, domainHint: string) => {
  const [localPart, domain] = email.toLowerCase().split('@');

  let score = 0;

  if (domain === domainHint) {
    score += 80;
  }

  if (domain.endsWith(`.${domainHint}`)) {
    score += 30;
  }

  const roleIndex = roleEmailPriority.indexOf(localPart);

  if (roleIndex >= 0) {
    score += 50 - roleIndex;
  }

  if (localPart.includes('contact')) score += 25;
  if (localPart.includes('hello')) score += 22;
  if (localPart.includes('info')) score += 18;
  if (localPart.includes('sales')) score += 15;
  if (localPart.includes('support')) score += 12;

  if (localPart.includes('noreply') || localPart.includes('no-reply')) {
    score -= 200;
  }

  if (domain.includes('gmail.com') || domain.includes('outlook.com') || domain.includes('yahoo.com')) {
    score -= 10;
  }

  return score;
};

const selectBestEmail = (emails: string[], domainHint: string) => {
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))];

  return normalized.sort((left, right) => {
    return getEmailScore(right, domainHint) - getEmailScore(left, domainHint);
  })[0] ?? '';
};

const selectBestPhone = (phones: string[], existingPhone?: string) => {
  const normalized = [...new Set(phones.map(normalizePhone).filter(Boolean))];

  if (!normalized.length) {
    return existingPhone ?? '';
  }

  if (existingPhone) {
    const existing = normalizePhone(existingPhone);

    if (existing && normalized.includes(existing)) {
      return existing;
    }
  }

  return normalized[0];
};

const selectBestAddress = (addresses: string[], existingAddress?: string) => {
  const normalized = [
    ...new Set(
      addresses
        .map((address) => address.replace(/\s+/g, ' ').trim())
        .filter((address) => address.length >= 12 && address.length <= 240),
    ),
  ];

  if (existingAddress && existingAddress.trim().length >= 12) {
    return existingAddress;
  }

  return normalized.sort((left, right) => {
    const leftScore = Number(/\b\d{5}(?:-\d{4})?\b/.test(left)) * 20 + Number(/\b[A-Z]{2}\b/.test(left)) * 10;
    const rightScore = Number(/\b\d{5}(?:-\d{4})?\b/.test(right)) * 20 + Number(/\b[A-Z]{2}\b/.test(right)) * 10;

    return rightScore - leftScore;
  })[0] ?? '';
};

const getContactPathScore = (candidate: URL) => {
  const value = `${candidate.pathname} ${candidate.search}`.toLowerCase();

  let score = 0;

  if (/\/contact(?:-us)?\/?$/i.test(candidate.pathname)) score += 100;
  if (/contact/i.test(value)) score += 80;
  if (/location|locations|office|offices/i.test(value)) score += 60;
  if (/about/i.test(value)) score += 45;
  if (/team|staff|doctors|attorneys|dentists|providers/i.test(value)) score += 35;
  if (/service|services/i.test(value)) score += 20;
  if (/support|help/i.test(value)) score += 15;
  if (/privacy|terms|login|cart|checkout|account|wp-admin/i.test(value)) score -= 100;

  return score;
};

const getInternalLinks = (html: string, currentUrl: URL, origin: URL) => {
  const $ = cheerio.load(html);
  const links = new Map<string, number>();

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

      if (isLikelyAssetUrl(candidate)) {
        return;
      }

      candidate.hash = '';

      const score = getContactPathScore(candidate);

      if (score <= 0) {
        return;
      }

      const canonical = canonicalizeUrl(candidate.toString());
      links.set(canonical, Math.max(links.get(canonical) ?? 0, score));
    } catch {
      return;
    }
  });

  return [...links.entries()]
    .sort(([, leftScore], [, rightScore]) => rightScore - leftScore)
    .map(([url, score]) => ({ url, score }));
};

const addSourceTag = (source: string, tag: string) => {
  const parts = source
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.includes(tag)) {
    parts.push(tag);
  }

  return parts.join(', ');
};

const shouldKeepExistingValue = (existing?: string | null) => {
  return Boolean(existing && existing.trim().length >= 5);
};

const createWarning = (message: string): ProviderWarning => ({
  providerId: 'website-crawl',
  providerName: 'Website Crawl',
  message,
});

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

  let origin: URL;

  try {
    origin = new URL(website);
  } catch {
    return {
      lead,
      warnings: [createWarning(`Invalid website URL for ${lead.name ?? 'lead'}.`)],
    };
  }

  if (isSocialHost(origin.hostname) || isLikelyAssetUrl(origin)) {
    return { lead, warnings: [] };
  }

  const queue: CrawlPage[] = [
    {
      url: canonicalizeUrl(website),
      depth: 0,
      score: 100,
    },
  ];

  const visited = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const addresses = new Set<string>();
  const socialUrls = new Set<string>();
  const warnings: ProviderWarning[] = [];

  let blockedCount = 0;
  let timeoutCount = 0;

  while (queue.length && visited.size < maxPages) {
    queue.sort((left, right) => right.score - left.score);

    const current = queue.shift();

    if (!current || current.depth > maxDepth) {
      continue;
    }

    const currentUrl = canonicalizeUrl(current.url);

    if (visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    try {
      const response = await httpClient.get<string>(currentUrl, {
        timeout: requestTimeoutMs,
        responseType: 'text',
        maxContentLength: maxHtmlBytes,
        maxBodyLength: maxHtmlBytes,
        headers: {
          'User-Agent': 'LeadFinderPro/1.0 (US-only enrichment)',
          Accept: 'text/html,application/xhtml+xml',
        },
        validateStatus: () => true,
      });

      const contentType = String(response.headers['content-type'] ?? '').toLowerCase();

      if (response.status === 429 || response.status === 403 || blockedPattern.test(String(response.data ?? ''))) {
        blockedCount += 1;
        continue;
      }

      if (response.status >= 400) {
        warnings.push(createWarning(`${currentUrl} returned HTTP ${response.status}.`));
        continue;
      }

      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        continue;
      }

      const html = String(response.data ?? '');

      if (!html.trim()) {
        continue;
      }

      const extracted = extractContactDetailsFromHtml(html, currentUrl);

      extracted.emails.forEach((email) => emails.add(email));
      extracted.phones.forEach((phone) => phones.add(phone));
      extracted.addresses.forEach((address) => addresses.add(address));
      extracted.socialUrls.forEach((socialUrl) => socialUrls.add(socialUrl));

      for (const link of getInternalLinks(html, new URL(currentUrl), origin)) {
        if (visited.has(link.url)) {
          continue;
        }

        if (queue.length + visited.size >= maxPages) {
          break;
        }

        queue.push({
          url: link.url,
          depth: current.depth + 1,
          score: link.score - current.depth * 10,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (/timeout|exceeded|aborted/i.test(message)) {
        timeoutCount += 1;
      } else {
        warnings.push(createWarning(`${currentUrl} could not be crawled.`));
      }

      continue;
    }
  }

  const domainHint = origin.hostname.replace(/^www\./i, '').toLowerCase();

  const crawledEmail = selectBestEmail([...emails], domainHint);
  const crawledPhone = selectBestPhone([...phones], lead.mobile);
  const crawledAddress = selectBestAddress([...addresses], lead.address);

  const email = shouldKeepExistingValue(lead.email) ? lead.email ?? '' : crawledEmail;
  const phone = shouldKeepExistingValue(lead.mobile) ? lead.mobile ?? '' : crawledPhone;
  const address = shouldKeepExistingValue(lead.address) ? lead.address ?? '' : crawledAddress;

  const improved = Boolean(
    (!lead.email && email) ||
      (!lead.mobile && phone) ||
      (!lead.address && address),
  );

  const totalExtracted =
    emails.size +
    phones.size +
    addresses.size +
    socialUrls.size;

  if (!totalExtracted && blockedCount > 0 && blockedCount >= visited.size) {
    return {
      lead: {
        ...lead,
        website,
        crawlAttempts: visited.size,
        rejectionReason: lead.rejectionReason ?? 'blocked_website',
      },
      warnings: [],
    };
  }

  if (!totalExtracted && timeoutCount > 0 && timeoutCount >= visited.size) {
    warnings.push(createWarning(`Timed out during contact crawling for ${website}.`));
  }

  return {
    lead: {
      ...lead,
      email,
      mobile: phone,
      address,
      website,
      hasEmail: Boolean(email),
      hasPhone: Boolean(phone),
      hasWebsite: Boolean(website),
      crawlAttempts: visited.size,
      source: improved
        ? addSourceTag(lead.source ?? '', 'Website Crawl')
        : lead.source,
    },
    warnings,
  };
};