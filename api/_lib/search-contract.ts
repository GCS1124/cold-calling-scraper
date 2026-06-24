import { z } from 'zod';

import { usStateCodes } from '../../server/src/data/us-states.js';

const publicTimeZoneCodes = ['EST', 'CST', 'MST', 'PST'] as const;

const cityPattern = /^[\p{L}][\p{L}\s.'-]*$/u;

const citySchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .refine((value) => cityPattern.test(value), {
    message: 'City must contain letters, spaces, apostrophes, periods, or hyphens.',
  });

export const searchLocationSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('timezone'),
    timeZone: z.enum(publicTimeZoneCodes),
  }),
  z.object({
    mode: z.literal('cityState'),
    city: citySchema,
    stateCode: z.enum(usStateCodes),
  }),
]);

export const searchRequestSchema = z.object({
  companyType: z.string().trim().min(2).max(80),
  location: searchLocationSchema,
  count: z.number().int().min(1).max(500),
  filters: z
    .object({
      hasEmail: z.boolean().optional(),
      hasPhone: z.boolean().optional(),
      hasWebsite: z.boolean().optional(),
      sources: z.array(z.string()).optional(),
    })
    .optional(),
});

export type SearchLocation = z.infer<typeof searchLocationSchema>;
export type PublicSearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchRequest = PublicSearchRequest;

const timeZoneLabels: Record<(typeof publicTimeZoneCodes)[number], string> = {
  EST: 'Eastern Time',
  CST: 'Central Time',
  MST: 'Mountain Time',
  PST: 'Pacific Time',
};

const normalizeText = (value: string) => value.trim().replace(/\s+/g, ' ');

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

  return `${normalizeText(location.city)}, ${location.stateCode}`;
};

export const flattenSearchRequest = (request: PublicSearchRequest) => ({
  companyType: request.companyType.trim(),
  city: serializeLocationValue(request.location),
  count: Math.max(request.count, 50),
  filters: request.filters,
});
