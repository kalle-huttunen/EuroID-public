import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const TriggerReconciliationSchema = z.object({
  targetSystems: z.array(z.string()),
});

export class TriggerReconciliationDto extends createZodDto(TriggerReconciliationSchema) {}
