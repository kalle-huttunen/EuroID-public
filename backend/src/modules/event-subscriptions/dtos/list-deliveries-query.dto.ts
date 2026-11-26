import { z } from 'zod';
import { MAX_OFFSET } from '@shared/utils/pagination-validator';

/**
 * Paging of GET /event-subscriptions/:id/deliveries. Whole numbers only: a negative offset went
 * to MongoDB as a negative skip (500), and text or a fraction fell back to a default silently.
 */
export const ListDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
});
