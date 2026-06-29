import axios from 'axios';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { usStateNames, type UsStateCode } from '../data/us-states';
import type { NormalizedUsLocation } from '../services/us-location';
import { resolveCategoryProfile } from '../services/us-category-mapping';
import type { Lead } from '../types/lead';
import type { LeadProvider, LeadProviderRequest } from './provider';

type LegacyPlaceSummary = {
  place_id?: string;
  name?: string;
  formatted_address?: string;
};

type LegacyTextSearchResponse = {
  status?: string;
  error_message?: string;
  results?: LegacyPlaceSummary[];
  next_page_token?: string;
};

type LegacyDetailsResponse = {
  status?: string;
  error_message?: string;
  result?: {
    place_id?: string;
    name?: string;
    formatted_phone_number?: string;
    international_phone_number?: string;
    website?: string;
    formatted_address?: string;
  };
};

type NewPlaceSummary = {
  id?: string;
  name?: string;
  displayName?: {
    text?: string;
    languageCode?: string;
  };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
};

type NewTextSearchResponse = {
  places?: NewPlaceSummary[];
  nextPageToken?: string;
};

type NewPlaceDetailsResponse = NewPlaceSummary & {
  id?: string;
  name?: string;
};

type PlaceCandidate = {
  placeId: string;
  name?: string;
  formattedAddress?: string;
  phone?: string;
  website?: string;
  sourceKind: 'legacy' | 'new';
};

const legacyTextSearchUrl = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const legacyDetailsUrl = 'https://maps.googleapis.com/maps/api/place/details/json';
const newTextSearchUrl = 'https://places.googleapis.com/v1/places:searchText';
const newDetailsBaseUrl = 'https://places.googleapis.com/v1/places/';
const newSearchFieldMask =
  'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,nextPageToken';
const newDetailsFieldMask =
  'id,displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri';

const toLeadId = (placeId?: string, fallbackIndex?: number) =>
  placeId ? `google-${placeId}` : `google-${fallbackIndex ?? 0}`;

const normalizeWebsite = (value?: string) => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const normalizePhone = (value?: string) => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }

  const parsed = parsePhoneNumberFromString(trimmed, 'US');
  if (parsed?.isValid()) {
    return parsed.formatInternational().replace(/-/g, ' ');
  }

  return trimmed.replace(/\s+/g, ' ');
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeQuery = (value: string) => value.trim().replace(/\s+/g, ' ');

const queryKey = (value: string) => normalizeQuery(value).toLowerCase();

const uniqueQueries = (values: string[]) => {
  const seen = new Set<string>();
  const queries: string[] = [];

  for (const value of values) {
    const normalized = normalizeQuery(value);
    const key = queryKey(normalized);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    queries.push(normalized);
  }

  return queries;
};

const mergeCandidate = (current: PlaceCandidate, incoming: PlaceCandidate): PlaceCandidate => ({
  placeId: current.placeId,
  name: incoming.name?.trim() || current.name?.trim() || '',
  formattedAddress:
    incoming.formattedAddress?.trim() || current.formattedAddress?.trim() || '',
  phone: incoming.phone?.trim() || current.phone?.trim() || '',
  website: incoming.website?.trim() || current.website?.trim() || '',
  sourceKind: current.sourceKind === 'new' || incoming.sourceKind === 'new' ? 'new' : 'legacy',
});

const upsertCandidate = (candidates: Map<string, PlaceCandidate>, candidate: PlaceCandidate) => {
  const existing = candidates.get(candidate.placeId);
  candidates.set(candidate.placeId, existing ? mergeCandidate(existing, candidate) : candidate);
};

const extractNewPlaceId = (place: NewPlaceSummary) => {
  const directId = place.id?.trim() ?? '';
  if (directId) {
    return directId;
  }

  const resourceName = place.name?.trim() ?? '';
  const resourceMatch = resourceName.match(/^places\/(.+)$/);
  return resourceMatch?.[1]?.trim() ?? '';
};

const extractNewPlaceName = (place: NewPlaceSummary) => {
  const displayName = place.displayName?.text?.trim() ?? '';
  if (displayName) {
    return displayName;
  }

  const resourceName = place.name?.trim() ?? '';
  if (!resourceName) {
    return '';
  }

  const resourceMatch = resourceName.match(/^places\/(.+)$/);
  return resourceMatch?.[1]?.trim() ?? resourceName;
};

const distanceMeters = (leftLat: number, leftLon: number, rightLat: number, rightLon: number) => {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(rightLat - leftLat);
  const deltaLon = toRadians(rightLon - leftLon);
  const lat1 = toRadians(leftLat);
  const lat2 = toRadians(rightLat);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusMeters * c;
};

const buildLocationBias = (location?: NormalizedUsLocation) => {
  if (!location || location.mode !== 'local') {
    return undefined;
  }

  const corners = [
    [location.boundingBox.north, location.boundingBox.west],
    [location.boundingBox.north, location.boundingBox.east],
    [location.boundingBox.south, location.boundingBox.west],
    [location.boundingBox.south, location.boundingBox.east],
  ] as const;

  const radiusMeters = Math.max(
    1_000,
    Math.min(
      50_000,
      Math.ceil(
        Math.max(
          ...corners.map(([lat, lon]) => distanceMeters(location.lat, location.lon, lat, lon)),
        ),
      ),
    ),
  );

  return {
    circle: {
      center: {
        latitude: location.lat,
        longitude: location.lon,
      },
      radius: radiusMeters,
    },
  };
};

const buildNewSearchBody = (
  searchQuery: string,
  pageToken: string | undefined,
  location?: NormalizedUsLocation,
) => {
  const body: Record<string, unknown> = {
    textQuery: searchQuery,
    pageSize: 20,
    includePureServiceAreaBusinesses: true,
    languageCode: 'en',
    regionCode: 'us',
  };

  if (pageToken) {
    body.pageToken = pageToken;
  }

  const locationBias = buildLocationBias(location);
  if (locationBias) {
    body.locationBias = locationBias;
  }

  return body;
};

const createLegacyCandidate = (place: LegacyPlaceSummary): PlaceCandidate | null => {
  const placeId = place.place_id?.trim() ?? '';
  if (!placeId) {
    return null;
  }

  return {
    placeId,
    name: place.name?.trim() ?? '',
    formattedAddress: place.formatted_address?.trim() ?? '',
    phone: '',
    website: '',
    sourceKind: 'legacy',
  };
};

const createNewCandidate = (place: NewPlaceSummary): PlaceCandidate | null => {
  const placeId = extractNewPlaceId(place);
  if (!placeId) {
    return null;
  }

  return {
    placeId,
    name: extractNewPlaceName(place),
    formattedAddress: place.formattedAddress?.trim() ?? '',
    phone: normalizePhone(place.nationalPhoneNumber ?? place.internationalPhoneNumber),
    website: normalizeWebsite(place.websiteUri),
    sourceKind: 'new',
  };
};

const fetchLegacyTextSearchPage = async (
  apiKey: string,
  searchQuery: string,
  pageToken: string | undefined,
) => {
  const response = await axios.get<LegacyTextSearchResponse>(legacyTextSearchUrl, {
    params: {
      key: apiKey,
      query: searchQuery,
      language: 'en',
      pagetoken: pageToken,
    },
    timeout: 4_000,
  });

  return response.data;
};

const fetchLegacyPlaceDetails = async (apiKey: string, placeId: string) => {
  const response = await axios.get<LegacyDetailsResponse>(legacyDetailsUrl, {
    params: {
      key: apiKey,
      place_id: placeId,
      fields: [
        'place_id',
        'name',
        'formatted_phone_number',
        'international_phone_number',
        'website',
        'formatted_address',
      ].join(','),
      language: 'en',
    },
    timeout: 3_000,
  });

  return response.data;
};

const fetchNewTextSearchPage = async (
  apiKey: string,
  searchQuery: string,
  pageToken: string | undefined,
  location?: NormalizedUsLocation,
) => {
  const response = await axios.post<NewTextSearchResponse>(
    newTextSearchUrl,
    buildNewSearchBody(searchQuery, pageToken, location),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': newSearchFieldMask,
      },
      timeout: 4_000,
    },
  );

  return response.data;
};

const fetchNewPlaceDetails = async (apiKey: string, placeId: string) => {
  const response = await axios.get<NewPlaceDetailsResponse>(
    `${newDetailsBaseUrl}${encodeURIComponent(placeId)}`,
    {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': newDetailsFieldMask,
      },
      timeout: 3_000,
    },
  );

  return response.data;
};

const collectLegacyCandidates = async (
  apiKey: string,
  searchQuery: string,
  deadlineMs: number,
) => {
  const candidates: PlaceCandidate[] = [];
  let pageToken: string | undefined;

  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    if (Date.now() >= deadlineMs) {
      break;
    }

    if (pageIndex > 0) {
      if (Date.now() + 2_000 >= deadlineMs) {
        break;
      }

      await delay(2_000);
    }

    let data: LegacyTextSearchResponse;
    try {
      data = await fetchLegacyTextSearchPage(apiKey, searchQuery, pageToken);
    } catch {
      break;
    }

    if (data.status === 'ZERO_RESULTS') {
      break;
    }

    if (data.status && data.status !== 'OK') {
      break;
    }

    for (const place of data.results ?? []) {
      const candidate = createLegacyCandidate(place);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    pageToken = data.next_page_token;
    if (!pageToken) {
      break;
    }
  }

  return candidates;
};

const collectNewCandidates = async (
  apiKey: string,
  searchQuery: string,
  deadlineMs: number,
  location: NormalizedUsLocation | undefined,
) => {
  const candidates: PlaceCandidate[] = [];
  let pageToken: string | undefined;

  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    if (Date.now() >= deadlineMs) {
      break;
    }

    if (pageIndex > 0) {
      if (Date.now() + 2_000 >= deadlineMs) {
        break;
      }

      await delay(2_000);
    }

    let data: NewTextSearchResponse;
    try {
      data = await fetchNewTextSearchPage(apiKey, searchQuery, pageToken, location);
    } catch {
      break;
    }

    const places = data.places ?? [];
    if (!places.length) {
      break;
    }

    for (const place of places) {
      const candidate = createNewCandidate(place);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    pageToken = data.nextPageToken;
    if (!pageToken) {
      break;
    }
  }

  return candidates;
};

const buildLocationTerms = (locationLabel: string, location?: NormalizedUsLocation) => {
  if (location?.mode === 'nationwide') {
    return ['United States'];
  }

  const isCityStateLocal = Boolean(
    location?.mode === 'local' &&
      location?.label?.includes(',') &&
      location.city?.trim(),
  );

  if (isCityStateLocal && location) {
    const city = location.city.trim();
    const label = location.label.trim();
    const stateName = location.stateCode ? usStateNames[location.stateCode as UsStateCode] : '';

    return uniqueQueries([
      label,
      city,
      `${city}, ${location.stateCode}`,
      `${city} ${location.stateCode}`,
      stateName ? `${city}, ${stateName}` : '',
      stateName ? `${city} ${stateName}` : '',
      `${city} area`,
      `greater ${city}`,
      `${city} metro`,
      `${city} metro area`,
      `downtown ${city}`,
      `central ${city}`,
      `north ${city}`,
      `south ${city}`,
      `east ${city}`,
      `west ${city}`,
    ]).slice(0, 13);
  }

  return uniqueQueries([
    location?.label ?? locationLabel,
    location?.city && location?.stateCode ? `${location.city} ${location.stateCode}` : '',
    location?.city && location.city !== (location?.label ?? locationLabel) ? location.city : '',
    location?.stateCode ?? '',
  ]).slice(0, 4);
};

const buildExpandedSearchQueries = (
  companyType: string,
  locationLabel: string,
  location: NormalizedUsLocation | undefined,
  baselineQueries: string[],
) => {
  const profile = resolveCategoryProfile(companyType);
  const baselineKeys = new Set(baselineQueries.map(queryKey));
  const locationTerms = buildLocationTerms(locationLabel, location);
  const categoryTerms = uniqueQueries([
    ...profile.searchTerms,
    profile.label,
    companyType,
  ]);
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const categoryTerm of categoryTerms) {
    for (const locationTerm of locationTerms) {
      const query = normalizeQuery(`${categoryTerm} in ${locationTerm}`);
      const key = queryKey(query);
      if (!key || baselineKeys.has(key) || seen.has(key)) {
        continue;
      }

      seen.add(key);
      queries.push(query);

      if (queries.length >= 12) {
        return queries;
      }
    }

    if (
      location?.mode !== 'nationwide' &&
      location?.city &&
      location.city !== (location?.label ?? locationLabel)
    ) {
      const query = normalizeQuery(`${categoryTerm} near ${location.city}`);
      const key = queryKey(query);
      if (!key || baselineKeys.has(key) || seen.has(key)) {
        continue;
      }

      seen.add(key);
      queries.push(query);

      if (queries.length >= 12) {
        return queries;
      }
    }
  }

  const isCityStateLocal = Boolean(
    location?.mode === 'local' &&
      location?.label?.includes(',') &&
      location.city?.trim(),
  );

  return queries.slice(0, isCityStateLocal ? 18 : 12);
};

const collectCandidatesForQueries = async (
  searchQueries: string[],
  deadlineMs: number,
  maxLeadCount: number,
  candidates: Map<string, PlaceCandidate>,
  collectForQuery: (searchQuery: string) => Promise<PlaceCandidate[]>,
) => {
  for (const searchQuery of searchQueries) {
    if (Date.now() >= deadlineMs || candidates.size >= maxLeadCount) {
      break;
    }

    const queryCandidates = await collectForQuery(searchQuery);
    for (const candidate of queryCandidates) {
      upsertCandidate(candidates, candidate);
      if (candidates.size >= maxLeadCount) {
        break;
      }
    }
  }
};

const hydrateLegacyCandidate = async (
  apiKey: string,
  candidate: PlaceCandidate,
  index: number,
  request: LeadProviderRequest['request'],
) => {
  const baseLead = {
    id: toLeadId(candidate.placeId, index),
    name: candidate.name?.trim() || 'Unknown company',
    mobile: '',
    email: '',
    website: normalizeWebsite(candidate.website),
    address: candidate.formattedAddress?.trim() ?? '',
    category: request.companyType,
    city: request.city,
    source: 'Google Places',
    confidence: 68,
    sourceScore: 95,
    hasEmail: false,
    hasPhone: false,
    hasWebsite: Boolean(candidate.website?.trim()),
    verifiedPhone: false,
    verifiedEmail: false,
    scrapedAt: new Date().toISOString(),
  } satisfies Lead;

  try {
    const details = await fetchLegacyPlaceDetails(apiKey, candidate.placeId);
    if (details.status && details.status !== 'OK') {
      return baseLead;
    }

    const result = details.result ?? {};
    const website = normalizeWebsite(result.website ?? candidate.website);
    const phone = normalizePhone(
      result.formatted_phone_number ?? result.international_phone_number,
    );

    return {
      ...baseLead,
      name: result.name?.trim() || candidate.name?.trim() || baseLead.name,
      mobile: phone,
      website,
      address: result.formatted_address?.trim() || candidate.formattedAddress?.trim() || '',
      hasPhone: Boolean(phone),
      hasWebsite: Boolean(website),
      verifiedPhone: Boolean(phone),
    } satisfies Lead;
  } catch {
    return baseLead;
  }
};

const hydrateNewCandidate = async (
  apiKey: string,
  candidate: PlaceCandidate,
  index: number,
  request: LeadProviderRequest['request'],
) => {
  const baseLead = {
    id: toLeadId(candidate.placeId, index),
    name: candidate.name?.trim() || 'Unknown company',
    mobile: normalizePhone(candidate.phone),
    email: '',
    website: normalizeWebsite(candidate.website),
    address: candidate.formattedAddress?.trim() ?? '',
    category: request.companyType,
    city: request.city,
    source: 'Google Places',
    confidence: 72,
    sourceScore: 96,
    hasEmail: false,
    hasPhone: Boolean(candidate.phone?.trim()),
    hasWebsite: Boolean(candidate.website?.trim()),
    verifiedPhone: Boolean(candidate.phone?.trim()),
    verifiedEmail: false,
    scrapedAt: new Date().toISOString(),
  } satisfies Lead;

  if (candidate.phone?.trim() && candidate.website?.trim()) {
    return baseLead;
  }

  try {
    const details = await fetchNewPlaceDetails(apiKey, candidate.placeId);
    const phone = normalizePhone(
      details.nationalPhoneNumber ?? details.internationalPhoneNumber ?? candidate.phone,
    );
    const website = normalizeWebsite(details.websiteUri ?? candidate.website);

    return {
      ...baseLead,
      name:
        details.displayName?.text?.trim() ||
        candidate.name?.trim() ||
        baseLead.name,
      mobile: phone,
      website,
      address: details.formattedAddress?.trim() || candidate.formattedAddress?.trim() || '',
      hasPhone: Boolean(phone),
      hasWebsite: Boolean(website),
      verifiedPhone: Boolean(phone),
    } satisfies Lead;
  } catch {
    return baseLead;
  }
};

export const googlePlacesProvider: LeadProvider = {
  id: 'google-places',
  name: 'Google Places',
  async fetchLeads({
    query,
    queryVariants = [],
    request,
    location,
    deadlineMs: requestDeadlineMs,
  }: LeadProviderRequest) {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_API_KEY is not configured');
    }

    const deadlineMs = requestDeadlineMs ?? Date.now() + 5_000;
    const isCityStateLocal = Boolean(
      location?.mode === 'local' &&
        location?.label?.includes(',') &&
        location.city?.trim(),
    );
    const maxLeadCount = isCityStateLocal
      ? Math.min(Math.max(request.count * 2, 80), 120)
      : Math.min(request.count, 60);
    const searchQueries = uniqueQueries([query, ...queryVariants]).slice(
      0,
      isCityStateLocal ? 24 : 10,
    );

    const candidateMap = new Map<string, PlaceCandidate>();
    const locationLabel = location?.label ?? request.city;
    const expandedSearchQueries = buildExpandedSearchQueries(
      request.companyType,
      locationLabel,
      location,
      searchQueries,
    );

    await collectCandidatesForQueries(
      searchQueries,
      deadlineMs,
      maxLeadCount,
      candidateMap,
      (searchQuery) => collectNewCandidates(apiKey, searchQuery, deadlineMs, location),
    );

    if (candidateMap.size < maxLeadCount && expandedSearchQueries.length) {
      await collectCandidatesForQueries(
        expandedSearchQueries,
        deadlineMs,
        maxLeadCount,
        candidateMap,
        (searchQuery) => collectNewCandidates(apiKey, searchQuery, deadlineMs, location),
      );
    }

    if (candidateMap.size < maxLeadCount) {
      await collectCandidatesForQueries(
        searchQueries,
        deadlineMs,
        maxLeadCount,
        candidateMap,
        (searchQuery) => collectLegacyCandidates(apiKey, searchQuery, deadlineMs),
      );
    }

    const uniqueCandidates = [...candidateMap.values()].slice(0, maxLeadCount);

    const leads = await Promise.all(
      uniqueCandidates.map(async (candidate, index): Promise<Lead> => {
        if (candidate.sourceKind === 'new') {
          return hydrateNewCandidate(apiKey, candidate, index, request);
        }

        return hydrateLegacyCandidate(apiKey, candidate, index, request);
      }),
    );

    return leads.filter((lead): lead is Lead => Boolean(lead));
  },
};
