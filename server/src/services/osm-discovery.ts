import { parsePhoneNumberFromString } from 'libphonenumber-js';

import type { Lead } from '../types/lead';
import { httpClient } from '../utils/http-client';
import type { CategoryProfile } from './us-category-mapping';
import type { NormalizedUsLocation } from './us-location';

type OverpassElementType = 'node' | 'way' | 'relation';

type OverpassElement = {
  type?: OverpassElementType;
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat: number;
    lon: number;
  };
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements?: OverpassElement[];
  remark?: string;
};

export type OsmDiscoveryResult = {
  leads: Lead[];
  warnings: {
    providerId: string;
    providerName: string;
    message: string;
  }[];
};

type BoundingBox = NormalizedUsLocation['boundingBox'];

const overpassEndpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

const overpassUserAgent = 'LeadFinderPro/1.0 (US-only discovery)';

const maxOverpassTimeoutSeconds = Number(
  process.env.OSM_OVERPASS_TIMEOUT_SECONDS ?? 25,
);

const overpassRequestTimeoutMs = Number(
  process.env.OSM_OVERPASS_HTTP_TIMEOUT_MS ?? 30_000,
);

const maxReturnedCandidates = Number(
  process.env.OSM_MAX_RETURNED_CANDIDATES ?? 600,
);

const maxQueryAreaDegrees = Number(
  process.env.OSM_MAX_QUERY_AREA_DEGREES ?? 35,
);

const ignoredNamePattern =
  /^(unknown|unnamed|no name|private|closed|permanently closed|vacant)$/i;

const closedTagValues = new Set([
  'closed',
  'disused',
  'abandoned',
  'demolished',
  'vacant',
  'no',
]);

const websiteKeys = [
  'website',
  'contact:website',
  'url',
  'contact:url',
  'brand:website',
  'operator:website',
];

const phoneKeys = [
  'phone',
  'contact:phone',
  'contact:mobile',
  'mobile',
];

const emailKeys = [
  'email',
  'contact:email',
  'operator:email',
];

const nameKeys = [
  'name',
  'official_name',
  'brand',
  'operator',
];

const socialKeys = [
  'contact:facebook',
  'facebook',
  'contact:instagram',
  'instagram',
  'contact:linkedin',
  'linkedin',
  'contact:twitter',
  'twitter',
];

const pickTag = (
  tags: Record<string, string> | undefined,
  keys: string[],
) => {
  if (!tags) return '';

  for (const key of keys) {
    const value = tags[key]?.trim();

    if (value) {
      return value;
    }
  }

  return '';
};

const pickTags = (
  tags: Record<string, string> | undefined,
  keys: string[],
) => {
  if (!tags) return [];

  return keys
    .map((key) => tags[key]?.trim())
    .filter((value): value is string => Boolean(value));
};

const normalizeWebsiteCandidate = (value: string) => {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  if (/^(mailto|tel|javascript|data):/i.test(trimmed)) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);

    if (!/^https?:$/i.test(url.protocol)) {
      return '';
    }

    url.hash = '';

    return url.toString();
  } catch {
    return '';
  }
};

const normalizeEmailCandidate = (value: string) => {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) return '';

  const cleaned = trimmed.replace(/^mailto:/i, '').split('?')[0].trim();

  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) {
    return '';
  }

  if (
    /@(example|domain|test)\.(com|org|net)$/i.test(cleaned) ||
    /^(noreply|no-reply|donotreply|do-not-reply)@/i.test(cleaned)
  ) {
    return '';
  }

  return cleaned;
};

const normalizePhoneCandidate = (value: string) => {
  const parsed = parsePhoneNumberFromString(value, 'US');

  if (!parsed?.isValid() || parsed.country !== 'US') {
    return '';
  }

  return parsed.formatInternational().replace(/-/g, ' ');
};

const normalizeName = (value: string) => {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+[|-]\s+.*$/g, '')
    .trim();
};

const buildAddress = (tags: Record<string, string> | undefined) => {
  if (!tags) return '';

  const streetLine = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:unit'] ? `Unit ${tags['addr:unit']}` : '',
  ]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' ');

  const localityLine = [
    tags['addr:city'] || tags['addr:place'],
    tags['addr:state'],
    tags['addr:postcode'],
  ]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(', ');

  const fullAddress = [streetLine, localityLine]
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();

  return fullAddress;
};

const getCoordinates = (element: OverpassElement) => {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    lat: Number(lat),
    lon: Number(lon),
  };
};

const isClosedOrLowQuality = (tags: Record<string, string> | undefined) => {
  if (!tags) return true;

  const lifecycleValues = [
    tags.disused,
    tags.abandoned,
    tags.demolished,
    tags.closed,
    tags.vacant,
    tags.operational_status,
  ]
    .map((value) => value?.trim().toLowerCase())
    .filter(Boolean);

  if (lifecycleValues.some((value) => closedTagValues.has(value))) {
    return true;
  }

  if (tags['disused:amenity'] || tags['abandoned:amenity'] || tags['was:amenity']) {
    return true;
  }

  const name = pickTag(tags, nameKeys);

  if (!name || ignoredNamePattern.test(name.trim())) {
    return true;
  }

  return false;
};

const getMatchedCategoryScore = (
  tags: Record<string, string> | undefined,
  profile: CategoryProfile,
) => {
  if (!tags) return 0;

  const searchable = [
    tags.name,
    tags.brand,
    tags.operator,
    tags.amenity,
    tags.shop,
    tags.office,
    tags.craft,
    tags.healthcare,
    tags.tourism,
    tags.leisure,
  ]
    .map((value) => value?.toLowerCase())
    .filter(Boolean)
    .join(' ');

  let score = 0;

  for (const term of profile.searchTerms) {
    const normalizedTerm = term.toLowerCase();

    if (searchable.includes(normalizedTerm)) {
      score += 10;
    }
  }

  if (profile.label && searchable.includes(profile.label.toLowerCase())) {
    score += 15;
  }

  return Math.min(score, 35);
};

const scoreLead = (
  lead: Lead,
  tags: Record<string, string> | undefined,
  profile: CategoryProfile,
) => {
  let score = 35;

  if (lead.name) score += 15;
  if (lead.website) score += 25;
  if (lead.mobile) score += 25;
  if (lead.email) score += 18;
  if (lead.address) score += 12;
  if (lead.website && lead.mobile) score += 12;
  if (lead.website && lead.email) score += 8;

  if (tags?.opening_hours) score += 5;
  if (tags?.brand || tags?.operator) score += 3;

  score += getMatchedCategoryScore(tags, profile);

  return Math.min(score, 100);
};

const getElementStableId = (element: OverpassElement) => {
  const type = element.type ?? 'node';
  return `osm-${type}-${element.id}`;
};

const leadDedupeKey = (lead: Lead) => {
  const website = lead.website?.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  const phone = lead.mobile?.replace(/\D/g, '');
  const email = lead.email?.toLowerCase();

  if (website) return `website:${website}`;
  if (phone) return `phone:${phone}`;
  if (email) return `email:${email}`;

  return [
    lead.name,
    lead.address,
    lead.city,
  ]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join('|');
};

const dedupeLeads = (leads: Lead[]) => {
  const seen = new Set<string>();
  const deduped: Lead[] = [];

  for (const lead of leads) {
    const key = leadDedupeKey(lead);

    if (!key) {
      deduped.push(lead);
      continue;
    }

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(lead);
    }
  }

  return deduped;
};

const bboxToOverpass = (bbox: BoundingBox) => {
  return `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
};

const getBoundingBoxArea = (bbox: BoundingBox) => {
  return Math.abs((bbox.north - bbox.south) * (bbox.east - bbox.west));
};

const splitBoundingBox = (
  bbox: BoundingBox,
  maxArea = maxQueryAreaDegrees,
): BoundingBox[] => {
  const area = getBoundingBoxArea(bbox);

  if (area <= maxArea) {
    return [bbox];
  }

  const latMid = (bbox.south + bbox.north) / 2;
  const lonMid = (bbox.west + bbox.east) / 2;

  const boxes: BoundingBox[] = [
    {
      south: bbox.south,
      west: bbox.west,
      north: latMid,
      east: lonMid,
    },
    {
      south: bbox.south,
      west: lonMid,
      north: latMid,
      east: bbox.east,
    },
    {
      south: latMid,
      west: bbox.west,
      north: bbox.north,
      east: lonMid,
    },
    {
      south: latMid,
      west: lonMid,
      north: bbox.north,
      east: bbox.east,
    },
  ];

  return boxes.flatMap((box) => splitBoundingBox(box, maxArea));
};

const buildOverpassQuery = (
  profile: CategoryProfile,
  bbox: BoundingBox,
  limit: number,
) => {
  const bboxValue = bboxToOverpass(bbox);

  const union = profile.tagClauses
    .map((clause) => `nwr${clause}(${bboxValue});`)
    .join('\n');

  return `
[out:json][timeout:${maxOverpassTimeoutSeconds}];
(
${union}
);
out center tags ${limit};
`.trim();
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchOverpass = async (
  query: string,
): Promise<OverpassResponse> => {
  let lastError: Error | null = null;

  for (let endpointIndex = 0; endpointIndex < overpassEndpoints.length; endpointIndex += 1) {
    const endpoint = overpassEndpoints[endpointIndex];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await httpClient.post<OverpassResponse>(endpoint, query, {
          headers: {
            'Content-Type': 'text/plain',
            'User-Agent': overpassUserAgent,
          },
          timeout: overpassRequestTimeoutMs,
          validateStatus: () => true,
        });

        if (result.status >= 500 || result.status === 429) {
          throw new Error(`Overpass ${endpoint} returned HTTP ${result.status}`);
        }

        if (result.status >= 400) {
          throw new Error(`Overpass request rejected with HTTP ${result.status}`);
        }

        if (result.data?.remark) {
          throw new Error(result.data.remark);
        }

        return result.data;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error('Overpass request failed');

        await wait(300 * (attempt + 1) * (endpointIndex + 1));
      }
    }
  }

  throw lastError ?? new Error('Overpass discovery failed');
};

const toLead = ({
  element,
  request,
  location,
  profile,
}: {
  element: OverpassElement;
  request: { companyType: string; count: number };
  location: NormalizedUsLocation;
  profile: CategoryProfile;
}): Lead | null => {
  const tags = element.tags;

  if (isClosedOrLowQuality(tags)) {
    return null;
  }

  const coordinates = getCoordinates(element);
  const rawName = pickTag(tags, nameKeys);
  const name = normalizeName(rawName);

  if (!name) {
    return null;
  }

  const website = normalizeWebsiteCandidate(
    pickTag(tags, websiteKeys),
  );

  const phone = normalizePhoneCandidate(
    pickTag(tags, phoneKeys),
  );

  const email = normalizeEmailCandidate(
    pickTag(tags, emailKeys),
  );

  const address = buildAddress(tags);

  const socialUrls = pickTags(tags, socialKeys)
    .map(normalizeWebsiteCandidate)
    .filter(Boolean);

  const lead: Lead = {
    id: getElementStableId(element),
    name,
    mobile: phone,
    email,
    website,
    address,
    category: request.companyType,
    city: location.label,
    source: 'OpenStreetMap',
    confidence: 0,
    sourceScore: 65,
    hasEmail: Boolean(email),
    hasPhone: Boolean(phone),
    hasWebsite: Boolean(website),
    verifiedPhone: Boolean(phone),
    verifiedEmail: Boolean(email),
    scrapedAt: new Date().toISOString(),

    /**
     * Add these to Lead type if not already present:
     * latitude?: number;
     * longitude?: number;
     * socialUrls?: string[];
     * osmType?: string;
     * osmId?: number;
     */
    ...(coordinates
      ? {
          latitude: coordinates.lat,
          longitude: coordinates.lon,
        }
      : {}),
    ...(socialUrls.length
      ? {
          socialUrls,
        }
      : {}),
    ...(element.type
      ? {
          osmType: element.type,
        }
      : {}),
    osmId: element.id,
  } as Lead;

  lead.confidence = scoreLead(lead, tags, profile);

  return lead;
};

export const discoverUsLeadsFromOsm = async ({
  request,
  location,
  profile,
}: {
  request: { companyType: string; count: number };
  location: NormalizedUsLocation;
  profile: CategoryProfile;
}): Promise<Lead[]> => {
  const requestedCount = Math.max(1, request.count || 25);
  const targetCount = Math.min(
    Math.max(requestedCount * 5, 150),
    maxReturnedCandidates,
  );

  const boxes =
    location.mode === 'local'
      ? [location.boundingBox]
      : splitBoundingBox(location.boundingBox);

  const elementsById = new Map<string, OverpassElement>();
  let lastError: Error | null = null;

  for (const box of boxes) {
    if (elementsById.size >= targetCount * 2) {
      break;
    }

    const query = buildOverpassQuery(profile, box, targetCount);

    try {
      const response = await fetchOverpass(query);

      for (const element of response.elements ?? []) {
        const id = getElementStableId(element);
        elementsById.set(id, element);
      }
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error('Overpass discovery failed');

      continue;
    }
  }

  if (!elementsById.size && lastError) {
    throw lastError;
  }

  const leads = dedupeLeads(
    [...elementsById.values()]
      .map((element) =>
        toLead({
          element,
          request,
          location,
          profile,
        }),
      )
      .filter((lead): lead is Lead => Boolean(lead)),
  ).sort(
    (left, right) =>
      right.confidence - left.confidence ||
      Number(right.hasWebsite) - Number(left.hasWebsite) ||
      Number(right.hasPhone) - Number(left.hasPhone) ||
      left.name.localeCompare(right.name),
  );

  const strongCandidates = leads.filter(
    (lead) => lead.website || lead.mobile || lead.email,
  );

  const fallbackCandidates = leads.filter(
    (lead) => !lead.website && !lead.mobile && !lead.email,
  );

  return [...strongCandidates, ...fallbackCandidates].slice(0, targetCount);
};