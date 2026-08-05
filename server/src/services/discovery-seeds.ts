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

const timezoneDiscoverySeeds: Record<UsTimeZoneCode, string[]> = {
  ET: [
    'New York, NY',
    'Miami, FL',
    'Atlanta, GA',
    'Charlotte, NC',
    'Philadelphia, PA',
    'Boston, MA',
    'Washington, DC',
    'Columbus, OH',
    'Raleigh, NC',
    'Tampa, FL',
    'Orlando, FL',
    'Detroit, MI',
    'Pittsburgh, PA',
    'Baltimore, MD',
    'Richmond, VA',
    'Jacksonville, FL',
  ],
  CT: [
    'Chicago, IL',
    'Houston, TX',
    'Dallas, TX',
    'Austin, TX',
    'San Antonio, TX',
    'Minneapolis, MN',
    'Nashville, TN',
    'New Orleans, LA',
    'Milwaukee, WI',
    'Kansas City, MO',
    'Oklahoma City, OK',
    'Omaha, NE',
    'Memphis, TN',
    'Birmingham, AL',
    'Louisville, KY',
    'St. Louis, MO',
  ],
  MT: [
    'Denver, CO',
    'Phoenix, AZ',
    'Salt Lake City, UT',
    'Albuquerque, NM',
    'Las Vegas, NV',
    'Boise, ID',
    'Colorado Springs, CO',
    'Tucson, AZ',
    'Billings, MT',
    'Cheyenne, WY',
  ],
  PT: [
    'Los Angeles, CA',
    'San Diego, CA',
    'San Francisco, CA',
    'San Jose, CA',
    'Sacramento, CA',
    'Seattle, WA',
    'Portland, OR',
    'Oakland, CA',
    'Fresno, CA',
    'Las Vegas, NV',
  ],
  AKT: ['Anchorage, AK', 'Fairbanks, AK', 'Juneau, AK', 'Wasilla, AK'],
  HAT: ['Honolulu, HI', 'Hilo, HI', 'Kailua, HI', 'Kapolei, HI'],
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
    return uniqueSeeds([
      ...(timezoneDiscoverySeeds[location.timeZoneCode as UsTimeZoneCode] ?? []),
      ...(timezoneStateQueries[location.timeZoneCode as UsTimeZoneCode] ?? []),
    ]);
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
