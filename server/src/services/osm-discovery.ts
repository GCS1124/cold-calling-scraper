import type { Lead } from '../types/lead';
import { httpClient } from '../utils/http-client';
import type { CategoryProfile } from './us-category-mapping';
import type { NormalizedUsLocation } from './us-location';

type OverpassElement = {
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
};

const overpassEndpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const pickTag = (tags: Record<string, string> | undefined, keys: string[]) =>
  keys.find((key) => tags?.[key]?.trim()) ? tags?.[keys.find((key) => tags?.[key]?.trim()) as string] ?? '' : '';

const scoreLead = (lead: Lead) => {
  let score = 40;
  if (lead.website) score += 25;
  if (lead.mobile) score += 25;
  if (lead.email) score += 10;
  if (lead.website && lead.mobile) score += 15;
  return score;
};

const normalizeWebsiteCandidate = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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
  const bbox = `${location.boundingBox.south},${location.boundingBox.west},${location.boundingBox.north},${location.boundingBox.east}`;
  const union = profile.tagClauses.map((clause) => `nwr${clause}(${bbox});`).join('\n');
  const query = `[out:json][timeout:12];(${union});out center tags;`;

  let response: OverpassResponse | null = null;
  let lastError: Error | null = null;

  for (const endpoint of overpassEndpoints) {
    try {
      const result = await httpClient.post<OverpassResponse>(endpoint, query, {
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': 'LeadFinderPro/1.0 (US-only discovery)',
        },
        timeout: 6000,
      });

      response = result.data;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Overpass request failed');
    }
  }

  if (!response) {
    throw lastError ?? new Error('Overpass discovery failed');
  }

  const leads = (response.elements ?? [])
    .map((element): Lead | null => {
      const name = element.tags?.name?.trim();
      if (!name) {
        return null;
      }

      const website = normalizeWebsiteCandidate(
        pickTag(element.tags, ['website', 'contact:website', 'url']),
      );
      const phone = pickTag(element.tags, ['phone', 'contact:phone']);

      const lead: Lead = {
        id: `osm-${element.id}`,
        name,
        mobile: phone,
        email: '',
        website,
        address: '',
        category: request.companyType,
        city: location.label,
        source: 'OpenStreetMap',
        confidence: 0,
        sourceScore: 65,
        hasEmail: false,
        hasPhone: false,
        hasWebsite: false,
        verifiedPhone: false,
        verifiedEmail: false,
        scrapedAt: new Date().toISOString(),
      };

      lead.confidence = scoreLead(lead);
      return lead;
    })
    .filter((lead): lead is Lead => Boolean(lead))
    .sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name));

  const strongCandidates = leads.filter((lead) => lead.website || lead.mobile);
  const fallbackCandidates = leads.filter((lead) => !lead.website && !lead.mobile);
  const targetCount = Math.max(request.count * 2, 80);
  const shortlist = [...strongCandidates, ...fallbackCandidates].slice(0, targetCount);

  return shortlist;
};
