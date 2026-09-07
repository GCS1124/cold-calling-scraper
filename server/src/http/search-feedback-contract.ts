import { z } from 'zod';

import { leadFeedbackEventTypes } from '../../../shared/lead-feedback';

export const searchFeedbackSchema = z.object({
  leadId: z.string().trim().min(1).max(160),
  eventType: z.enum(leadFeedbackEventTypes),
  reason: z.string().trim().max(500).optional(),
});
