/**
 * DTOs for compliance report generation.
 */

import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const GenerateReportDtoSchema = z.object({
  type: z.enum(['SOX', 'ISO27001']),
  dateRange: z.object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  }),
  format: z.enum(['PDF', 'CSV']),
});

export type GenerateReportDto = z.infer<typeof GenerateReportDtoSchema>;
export class GenerateReportBodyDto extends createZodDto(GenerateReportDtoSchema) {}
