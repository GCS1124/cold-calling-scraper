import { timeZoneLabelsByCode, type TimeZoneCode } from '../data/search-options';
import type { UsStateCode } from '../data/us-states';
import type { SearchDraft, SearchLocation, SearchRequest } from '../types/lead';

const normalizeText = (value: string) => value.trim().replace(/\s+/g, ' ');

export const createSearchDraft = (): SearchDraft => ({
  companyType: '',
  locationMode: 'timezone',
  timeZone: '',
  city: '',
  stateCode: '',
  count: 50,
});

export const serializeLocationValue = (location: SearchLocation) => {
  if (location.mode === 'timezone') {
    return location.timeZone;
  }

  return `${normalizeText(location.city)}, ${location.stateCode}`;
};

export const formatLocationLabel = (location: SearchLocation) => {
  if (location.mode === 'timezone') {
    return timeZoneLabelsByCode[location.timeZone] ?? location.timeZone;
  }

  const city = normalizeText(location.city);
  return `${city}, ${location.stateCode}`;
};

export const isSearchDraftComplete = (draft: SearchDraft) => {
  if (!draft.companyType.trim()) {
    return false;
  }

  if (draft.locationMode === 'timezone') {
    return Boolean(draft.timeZone);
  }

  return Boolean(draft.city.trim() && draft.stateCode);
};

export const buildSearchRequestFromDraft = (draft: SearchDraft): SearchRequest => {
  if (draft.locationMode === 'timezone') {
    if (!draft.timeZone) {
      throw new Error('Select a time zone before searching');
    }

    return {
      companyType: draft.companyType.trim(),
      location: {
        mode: 'timezone',
        timeZone: draft.timeZone as TimeZoneCode,
      },
      count: draft.count,
    };
  }

  if (!draft.city.trim()) {
    throw new Error('Enter a city before searching');
  }

  if (!draft.stateCode) {
    throw new Error('Select a state before searching');
  }

  return {
    companyType: draft.companyType.trim(),
    location: {
      mode: 'cityState',
      city: normalizeText(draft.city),
      stateCode: draft.stateCode as UsStateCode,
    },
    count: draft.count,
  };
};
