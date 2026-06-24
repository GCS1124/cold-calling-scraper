import type { PublicSearchRequest, SearchLocation } from '../../../api/_lib/search-contract.js';
import type { SearchRequest } from '../types/search.js';

const normalizeText = (value: string) => value.trim().replace(/\s+/g, ' ');

const timeZoneLabels: Record<Extract<SearchLocation, { mode: 'timezone' }>['timeZone'], string> = {
  EST: 'Eastern Time',
  CST: 'Central Time',
  MST: 'Mountain Time',
  PST: 'Pacific Time',
};

export const serializeLocationValue = (location: SearchLocation) => {
  if (location.mode === 'timezone') {
    return location.timeZone;
  }

  return `${normalizeText(location.city)}, ${location.stateCode}`;
};

export const formatLocationLabel = (location: SearchLocation) => {
  if (location.mode === 'timezone') {
    return timeZoneLabels[location.timeZone];
  }

  const city = normalizeText(location.city);
  return `${city}, ${location.stateCode}`;
};

export const flattenSearchRequest = (request: PublicSearchRequest): SearchRequest => ({
  companyType: request.companyType.trim(),
  city: serializeLocationValue(request.location),
  count: Math.max(request.count, 50),
  filters: request.filters,
});
