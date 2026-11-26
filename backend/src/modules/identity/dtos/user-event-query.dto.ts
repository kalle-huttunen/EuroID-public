import { z } from 'zod';

/** GET /identity/:id/events query (type, date range, limit). */
export const UserEventQuerySchema = z.object({
  type: z.string().max(100).optional(),
  dateFrom: z
    .string()
    .optional()
    .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'dateFrom must be valid ISO datetime' }),
  dateTo: z
    .string()
    .optional()
    .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'dateTo must be valid ISO datetime' }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
