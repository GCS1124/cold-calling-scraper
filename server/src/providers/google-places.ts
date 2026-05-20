import axios from 'axios';

import type { Lead } from '../types/lead';
import type { LeadProvider } from './provider';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  async fetchLeads({ query, request }) {
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
    let pageToken: string | undefined;

    for (let pageIndex = 0; pageIndex < 3 && allResults.length < request.count; pageIndex += 1) {
      const response = await axios.get<GooglePlacesResponse>(
        'https://maps.googleapis.com/maps/api/place/textsearch/json',
        {
          params: {
            key: apiKey,
            query,
            language: 'en',
            pagetoken: pageToken,
          },
          timeout: 12000,
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

      if (!pageToken || allResults.length >= request.count) {
        break;
      }

      await sleep(2000);
    }

    const uniqueResults = [...new Map(
      allResults
        .filter((place) => place.place_id)
        .map((place) => [place.place_id as string, place] as const),
    ).values()].slice(0, request.count);

    const leads = await Promise.all(
      uniqueResults.map(async (place, index) => {
        const detailsResponse = await axios.get<GooglePlaceDetailsResponse>(
          'https://maps.googleapis.com/maps/api/place/details/json',
          {
            params: {
              key: apiKey,
              place_id: place.place_id,
              fields: detailsFields,
              language: 'en',
            },
            timeout: 12000,
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
          qualified: false,
          hasEmail: false,
          hasPhone: Boolean(phone),
          hasWebsite: Boolean(website),
          verifiedPhone: Boolean(phone),
          verifiedEmail: false,
          scrapedAt: new Date().toISOString(),
        } satisfies Lead;
      }),
    );

    return leads;
  },
};
