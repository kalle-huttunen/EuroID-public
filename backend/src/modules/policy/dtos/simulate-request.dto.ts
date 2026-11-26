import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

/** Bounded JSON value schema with max depth of 5 and max array length of 100. */
function boundedJsonValue(depth = 0): z.ZodType<unknown> {
  if (depth >= 5) {
    return z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
  }
  return z.lazy(() =>
    z.union([
      z.string().max(2000),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(boundedJsonValue(depth + 1)).max(100),
      z.record(z.string().max(200), boundedJsonValue(depth + 1)),
    ]),
  );
}

const SimulateRequestBaseSchema = z.object({
  policyId: z.string().max(100).optional(),
  policy: z.record(z.string().max(200), boundedJsonValue()).optional(),
});

export const SimulateRequestSchema = SimulateRequestBaseSchema.refine(
  (d) => d.policyId || d.policy,
  { message: 'Either policyId or policy must be provided' },
);

export class SimulateRequestDto extends createZodDto(SimulateRequestBaseSchema) {}
