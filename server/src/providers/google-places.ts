import axios from 'axios';
import pLimit from 'p-limit';

import type { Lead } from '../types/lead';
import type { LeadProvider, LeadProviderRequest } from './provider';

type GooglePlacesResponse = {
  status?: string;
  error_message?: string;
  results?: Array<{
    place_id?: string;
    name?: string;
    formatted_address?: string;
  }>;
  next_page_token?: string;
};

type GooglePlaceDetailsResponse = {
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

const toLeadId = (placeId?: string, fallbackIndex?: number) =>
  placeId ? `google-${placeId}` : `google-${fallbackIndex ?? 0}`;

const normalizeWebsite = (value?: string) => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const normalizePhone = (value?: string) => (value?.trim() ?? '').replace(/\s+/g, ' ');

export const googlePlacesProvider: LeadProvider = {
  id: 'google-places',
  name: 'Google Places',
  async fetchLeads({ query, queryVariants = [], request, deadlineMs: requestDeadlineMs }: LeadProviderRequest) {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_API_KEY is not configured');
    }

    const detailsFields = [
      'place_id',
      'name',
      'formatted_phone_number',
      'international_phone_number',
      'website',
      'formatted_address',
    ].join(',');

    const allResults: GooglePlacesResponse['results'] = [];
    const searchQueries = [...new Set([query, ...queryVariants].map((value) => value.trim()).filter(Boolean))].slice(0, 1);
    const deadlineMs = requestDeadlineMs ?? Date.now() + 5_000;
    const limit = pLimit(2);
    const maxLeadCount = Math.min(request.count, 6);

    for (const searchQuery of searchQueries) {
      if (Date.now() >= deadlineMs) {
        break;
      }

      let pageToken: string | undefined;

      for (let pageIndex = 0; pageIndex < 1 && allResults.length < maxLeadCount; pageIndex += 1) {
        if (Date.now() >= deadlineMs) {
          break;
        }

        const response = await axios.get<GooglePlacesResponse>(
          'https://maps.googleapis.com/maps/api/place/textsearch/json',
          {
            params: {
              key: apiKey,
              query: searchQuery,
              language: 'en',
              pagetoken: pageToken,
            },
            timeout: 4000,
          },
        );

        if (response.data.status === 'ZERO_RESULTS') {
          break;
        }

        if (response.data.status && response.data.status !== 'OK') {
          throw new Error(
            response.data.error_message
              ? `Google Places: ${response.data.error_message}`
              : `Google Places returned ${response.data.status}`,
          );
        }

        allResults.push(...(response.data.results ?? []));
        pageToken = response.data.next_page_token;

        if (!pageToken || allResults.length >= maxLeadCount) {
          break;
        }

      }
    }

    const uniqueResults = [...new Map(
      allResults
        .filter((place) => place.place_id)
        .map((place) => [place.place_id as string, place] as const),
    ).values()].slice(0, maxLeadCount);

    const leads: Array<Lead | null> = await Promise.all(
      uniqueResults.map((place, index) =>
        limit(async () => {
          if (Date.now() >= deadlineMs) {
            return null;
          }

        const detailsResponse = await axios.get<GooglePlaceDetailsResponse>(
          'https://maps.googleapis.com/maps/api/place/details/json',
          {
            params: {
              key: apiKey,
              place_id: place.place_id,
              fields: detailsFields,
              language: 'en',
            },
            timeout: 4000,
          },
        );

        if (detailsResponse.data.status && detailsResponse.data.status !== 'OK') {
          throw new Error(
            detailsResponse.data.error_message
              ? `Google Places Details: ${detailsResponse.data.error_message}`
              : `Google Places Details returned ${detailsResponse.data.status}`,
          );
        }

        const details = detailsResponse.data.result ?? {};
        const website = normalizeWebsite(details.website);
        const phone = normalizePhone(details.formatted_phone_number ?? details.international_phone_number);

        return {
          id: toLeadId(place.place_id, index),
          name: details.name ?? place.name ?? 'Unknown company',
          mobile: phone,
          email: '',
          website,
          address: details.formatted_address ?? place.formatted_address ?? '',
          category: request.companyType,
          city: request.city,
          source: 'Google Places',
          confidence: 68,
          sourceScore: 95,
          hasEmail: false,
          hasPhone: Boolean(phone),
          hasWebsite: Boolean(website),
          verifiedPhone: Boolean(phone),
          verifiedEmail: false,
          scrapedAt: new Date().toISOString(),
        } satisfies Lead;
        }),
      ),
    );

    return leads.filter((lead): lead is Lead => Boolean(lead));
  },
};
