import pLimit from 'p-limit';

import type { Lead } from '../types/lead';
import type { ProviderWarning, SearchRequest } from '../types/search';
import type { NormalizedUsLocation } from './us-location';
import { enrichLead } from './lead-validation';
import { enrichLeadFromWebsite } from './website-enrichment';

type PublicSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type PublicContactEnrichmentResult = {
  leads: Lead[];
  warnings: ProviderWarning[];
  enrichedCount: number;
};

const providerId = 'linkedin-public-contact-enrichment';
const providerName = 'Public Contact Search';
const searchTimeoutMs = Number(
  process.env.LINKEDIN_CONTACT_SEARCH_TIMEOUT_MS ?? 3_500,
);
const concurrency = Number(
  process.env.LINKEDIN_CONTACT_ENRICHMENT_CONCURRENCY ?? 6,
);

const blockedBodyPatterns = [
  /captcha/i,
  /challenge/i,
  /too many requests/i,
  /unusual traffic/i,
  /verify.*not a bot/i,
  /access denied/i,
  /temporarily blocked/i,
  /forbidden/i,
];

const excludedHosts = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'facebook.com',
  'www.facebook.com',
  'instagram.com',
  'www.instagram.com',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'tiktok.com',
  'www.tiktok.com',
  'youtube.com',
  'www.youtube.com',
  'yelp.com',
  'www.yelp.com',
  'yellowpages.com',
  'www.yellowpages.com',
  'mapquest.com',
  'www.mapquest.com',
  'superpages.com',
  'www.superpages.com',
  'manta.com',
  'www.manta.com',
  'chamberofcommerce.com',
  'www.chamberofcommerce.com',
  'zoominfo.com',
  'www.zoominfo.com',
  'crunchbase.com',
  'www.crunchbase.com',
  'indeed.com',
  'www.indeed.com',
  'glassdoor.com',
  'www.glassdoor.com',
  'whitepages.com',
  'www.whitepages.com',
  'yahoo.com',
  'www.yahoo.com',
  'angi.com',
  'www.angi.com',
  'bbb.org',
  'www.bbb.org',
  'birdeye.com',
  'www.birdeye.com',
  'citysearch.com',
  'www.citysearch.com',
  'doximity.com',
  'www.doximity.com',
  'doctor.com',
  'www.doctor.com',
  'healthgrades.com',
  'www.healthgrades.com',
  'homeadvisor.com',
  'www.homeadvisor.com',
  'houzz.com',
  'www.houzz.com',
  'merchantcircle.com',
  'www.merchantcircle.com',
  'opencare.com',
  'www.opencare.com',
  'porch.com',
  'www.porch.com',
  'ratemds.com',
  'www.ratemds.com',
  'thumbtack.com',
  'www.thumbtack.com',
  'vitals.com',
  'www.vitals.com',
  'webmd.com',
  'www.webmd.com',
  'zocdoc.com',
  'www.zocdoc.com',
  'r.jina.ai',
  'search.brave.com',
  'bing.com',
  'www.bing.com',
  'google.com',
  'www.google.com',
]);

const ignoredExtensions = /\.(?:pdf|png|jpe?g|gif|webp|svg|css|js|json|xml|zip)(?:$|[?#])/i;

const searchSources = [
  {
    label: 'Brave Search',
    buildUrl: (query: string) =>
      `https://r.jina.ai/http://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
    decodeUrl: (value: string) => value,
  },
  {
    label: 'Bing',
    buildUrl: (query: string) =>
      `https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(query)}`,
    decodeUrl: (value: string) => decodeBingUrl(value),
  },
] as const;

const normalizeText = (value?: string | null) =>
  (value ?? '').replace(/\s+/g, ' ').trim();

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );

const stripMarkdown = (value: string) =>
  decodeHtmlEntities(
    value
      .replace(/!\[[^\]]*\]\((?:[^)]+)\)/g, ' ')
      .replace(/\[([^\]]*?)\]\((https?:\/\/[^)]+)\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .trim(),
  );

const extractUrls = (value: string) =>
  Array.from(
    value.matchAll(/https?:\/\/[^\s<>"')\]]+/gi),
    (match) => match[0].replace(/[.,;:]+$/, ''),
  );

const decodeBingUrl = (value: string) => {
  try {
    const url = value.startsWith('//') ? new URL(`https:${value}`) : new URL(value);
    const encoded = url.searchParams.get('u');

    if (!encoded) {
      return value;
    }

    const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded;
    return Buffer.from(payload, 'base64').toString('utf8');
  } catch {
    return value;
  }
};

const normalizeWebsite = (value: string) => {
  try {
    const url = new URL(value);
    url.hash = '';

    if (!/^https?:$/i.test(url.protocol)) {
      return '';
    }

    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
    }

    return url.toString();
  } catch {
    return '';
  }
};

const isExcludedHost = (value: string) => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    const withoutWww = hostname.replace(/^www\./, '');

    return (
      excludedHosts.has(hostname) ||
      excludedHosts.has(withoutWww) ||
      withoutWww.endsWith('.linkedin.com') ||
      withoutWww.endsWith('.yahoo.com') ||
      withoutWww.endsWith('.yelp.com') ||
      withoutWww.endsWith('.yellowpages.com') ||
      withoutWww.endsWith('.healthgrades.com') ||
      withoutWww.endsWith('.opencare.com') ||
      withoutWww.endsWith('.zocdoc.com') ||
      withoutWww.endsWith('.search.brave.com') ||
      withoutWww.endsWith('.bing.com') ||
      withoutWww.endsWith('.google.com')
    );
  } catch {
    return true;
  }
};

const isCandidateWebsite = (value: string) => {
  const normalized = normalizeWebsite(value);

  if (!normalized || isExcludedHost(normalized)) {
    return '';
  }

  try {
    const url = new URL(normalized);

    if (ignoredExtensions.test(url.pathname)) {
      return '';
    }

    return normalized;
  } catch {
    return '';
  }
};

const parsePublicSearchResults = (
  markdown: string,
  decodeUrl: (value: string) => string,
) => {
  const results: PublicSearchResult[] = [];
  const lines = markdown.split(/\r?\n/);
  let current: PublicSearchResult | null = null;

  const flush = () => {
    if (current) {
      results.push({
        ...current,
        title: normalizeText(current.title),
        snippet: normalizeText(current.snippet),
      });
    }

    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (
      line.startsWith('Title:') ||
      line.startsWith('URL Source:') ||
      line === 'Markdown Content:' ||
      line.startsWith('About this page')
    ) {
      continue;
    }

    const website = extractUrls(line)
      .map((url) => decodeUrl(url))
      .map(isCandidateWebsite)
      .find(Boolean);
    const visibleText = stripMarkdown(line);

    if (website) {
      flush();
      current = {
        title: visibleText,
        url: website,
        snippet: '',
      };
      continue;
    }

    if (current) {
      current.snippet = `${current.snippet} ${visibleText}`.trim();
    }
  }

  flush();
  return results;
};

const fetchTextWithTimeout = async (url: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), searchTimeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/plain, text/markdown, text/html;q=0.9, */*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`Search request failed with status ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
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

const buildWarning = (sourceLabel: string, message: string): ProviderWarning => ({
  providerId: `${providerId}-${sourceLabel.toLowerCase().replace(/\s+/g, '-')}`,
  providerName: sourceLabel,
  message,
});

const buildQueries = (
  lead: Lead,
  request: SearchRequest,
  location: NormalizedUsLocation,
) => {
  const name = normalizeText(lead.name).replace(/["'`]+/g, ' ');
  const headline = normalizeText(lead.headline).replace(/["'`]+/g, ' ');
  const category = normalizeText(request.companyType || lead.category).replace(/["'`]+/g, ' ');
  const city = normalizeText(location.label || lead.city).replace(/["'`]+/g, ' ');

  if (!name || !city) {
    return [];
  }

  return [
    `"${name}" "${headline || category}" "${city}" contact -site:linkedin.com`,
    `"${name}" "${headline || category}" "${city}" phone email -site:linkedin.com`,
  ];
};

const scoreResult = (
  result: PublicSearchResult,
  lead: Lead,
  request: SearchRequest,
  location: NormalizedUsLocation,
) => {
  const searchable = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  const terms = [
    ...normalizeText(lead.name).toLowerCase().split(/\s+/),
    ...normalizeText(lead.headline).toLowerCase().split(/\s+/),
    ...normalizeText(request.companyType || lead.category).toLowerCase().split(/\s+/),
    ...normalizeText(location.city || location.label).toLowerCase().split(/\s+/),
  ].filter((term) => term.length >= 4);

  let score = 20;

  for (const term of new Set(terms)) {
    if (searchable.includes(term)) {
      score += term === normalizeText(lead.name).toLowerCase() ? 18 : 4;
    }
  }

  if (/contact|about|service|appointment/i.test(`${result.title} ${result.url}`)) {
    score += 10;
  }

  if (new URL(result.url).pathname === '/') {
    score += 4;
  }

  return score;
};

const resolveBusinessWebsite = async (
  lead: Lead,
  request: SearchRequest,
  location: NormalizedUsLocation,
  deadlineMs: number,
) => {
  const queries = buildQueries(lead, request, location);
  const warnings: ProviderWarning[] = [];
  const candidates = new Map<string, { result: PublicSearchResult; score: number }>();

  for (const query of queries) {
    if (Date.now() >= deadlineMs || candidates.size >= 3) {
      break;
    }

    const results = await Promise.all(
      searchSources.map(async (source) => {
        try {
          const body = await fetchTextWithTimeout(source.buildUrl(query));

          if (blockedBodyPatterns.some((pattern) => pattern.test(body))) {
            warnings.push(
              buildWarning(
                source.label,
                `${source.label} returned a blocked page while looking for a public business website for ${lead.name}.`,
              ),
            );
            return [] as PublicSearchResult[];
          }

          return parsePublicSearchResults(body, source.decodeUrl);
        } catch {
          warnings.push(
            buildWarning(
              source.label,
              `${source.label} could not be reached while looking for a public business website for ${lead.name}.`,
            ),
          );
          return [] as PublicSearchResult[];
        }
      }),
    );

    for (const sourceResults of results) {
      for (const result of sourceResults) {
        const website = isCandidateWebsite(result.url);

        if (!website || candidates.has(website)) {
          continue;
        }

        candidates.set(website, {
          result: { ...result, url: website },
          score: scoreResult({ ...result, url: website }, lead, request, location),
        });
      }
    }

    if (candidates.size) {
      break;
    }
  }

  const best = [...candidates.values()].sort((left, right) => right.score - left.score)[0];

  return {
    website: best && best.score >= 28 ? best.result.url : '',
    warnings,
  };
};

const enrichOneLead = async (
  lead: Lead,
  request: SearchRequest,
  location: NormalizedUsLocation,
  deadlineMs: number,
) => {
  const warnings: ProviderWarning[] = [];
  let enrichedLead = enrichLead(lead);
  let website = enrichedLead.website?.trim() ?? '';

  if (!website && Date.now() < deadlineMs) {
    const resolved = await resolveBusinessWebsite(lead, request, location, deadlineMs);
    warnings.push(...resolved.warnings);
    website = resolved.website;

    if (website) {
      enrichedLead = {
        ...enrichedLead,
        website,
        source: addSourceTag(enrichedLead.source, 'Public Web'),
      };
    }
  }

  if (website && Date.now() < deadlineMs) {
    const crawled = await enrichLeadFromWebsite({
      ...enrichedLead,
      website,
    });
    warnings.push(...crawled.warnings);
    enrichedLead = enrichLead(crawled.lead);
  }

  return { lead: enrichedLead, warnings };
};

const appendUniqueWarnings = (warnings: ProviderWarning[], incoming: ProviderWarning[]) => {
  for (const warning of incoming) {
    if (
      !warnings.some(
        (existing) =>
          existing.providerId === warning.providerId && existing.message === warning.message,
      )
    ) {
      warnings.push(warning);
    }
  }
};

export const enrichLinkedinLeadsWithPublicContacts = async ({
  leads,
  request,
  location,
  deadlineMs,
  onProgress,
}: {
  leads: Lead[];
  request: SearchRequest;
  location: NormalizedUsLocation;
  deadlineMs: number;
  onProgress?: (completed: number) => void;
}): Promise<PublicContactEnrichmentResult> => {
  const enriched = [...leads];
  const warnings: ProviderWarning[] = [];
  const limit = pLimit(Math.max(1, Math.min(10, concurrency)));
  let completed = 0;

  await Promise.all(
    leads.map((lead, index) =>
      limit(async () => {
        if (Date.now() >= deadlineMs) {
          return;
        }

        const result = await enrichOneLead(lead, request, location, deadlineMs);
        enriched[index] = result.lead;
        appendUniqueWarnings(warnings, result.warnings);
        completed += 1;
        onProgress?.(completed);
      }),
    ),
  );

  return {
    leads: enriched,
    warnings,
    enrichedCount: completed,
  };
};
