import { z } from 'zod';

export const searchRequestSchema = z.object({
  companyType: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(80),
  count: z.number().int().min(50).max(500),
  filters: z
    .object({
      hasEmail: z.boolean().optional(),
      hasPhone: z.boolean().optional(),
      hasWebsite: z.boolean().optional(),
      sources: z.array(z.string()).optional(),
    })
    .optional(),
});
