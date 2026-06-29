import { usStateNames, type UsStateCode } from '../data/us-states';
import { nationwideStateQueries } from './us-discovery-regions';
import { timezoneStateQueries, type UsTimeZoneCode } from './us-timezones';
import type { NormalizedUsLocation } from './us-location';

const normalizeSeed = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim();

const uniqueSeeds = (values: string[]) => {
  const seen = new Set<string>();
  const seeds: string[] = [];

  for (const value of values) {
    const normalized = normalizeSeed(value);
    const key = normalized.toLowerCase();

    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    seeds.push(normalized);
  }

  return seeds;
};

const buildCityStateSeeds = (location: NormalizedUsLocation) => {
  const city = location.city.trim() || location.label.split(',')[0]?.trim() || location.label;
  const stateName = location.stateCode ? usStateNames[location.stateCode as UsStateCode] : '';

  return uniqueSeeds([
    location.label,
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
  ]);
};

export const buildDiscoverySeeds = (location: NormalizedUsLocation) => {
  if (location.mode === 'nationwide') {
    return [...nationwideStateQueries];
  }

  if (location.mode === 'timezone' && location.timeZoneCode) {
    return [...(timezoneStateQueries[location.timeZoneCode as UsTimeZoneCode] ?? [])];
  }

  if (location.mode === 'local' && location.label.includes(',')) {
    return buildCityStateSeeds(location);
  }

  const seeds = [location.label];
  if (location.stateCode && location.stateCode !== location.label) {
    seeds.push(location.stateCode);
  }

  seeds.push(...nationwideStateQueries);
  return uniqueSeeds(seeds);
};
