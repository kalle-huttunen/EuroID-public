import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

/** PE-5: Cap to prevent DoS via unbounded bulkWrite */
const POLICY_REORDER_MAX = 500;

export const ReorderRequestSchema = z.object({
  orderedIds: z.array(z.string()).max(POLICY_REORDER_MAX, `orderedIds cannot exceed ${POLICY_REORDER_MAX} (PE-5)`),
});

export class ReorderRequestDto extends createZodDto(ReorderRequestSchema) {}
