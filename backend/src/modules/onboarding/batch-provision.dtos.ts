import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

/** The most operations bulkProvisioningWorkflow runs at once (as POST /bulk-provisioning/start). */
export const MAX_BATCH_SIZE = 1000;
/** The most test users one seed request creates (the bulk request's operation limit). */
export const MAX_SEED_COUNT = 10000;

/**
 * A boolean from JSON or a form/query string: "false" is false (Boolean("false") is true). A
 * preprocess, not a union with a transform, so the OpenAPI document can describe it.
 */
const booleanValue = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);

export const SeedRequestSchema = z.object({
  count: z.coerce.number().int().min(1).max(MAX_SEED_COUNT).optional(),
  domain: z.string().optional(),
});

export class SeedRequestDto extends createZodDto(SeedRequestSchema) {}

export const EntraProvisionRequestSchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(MAX_BATCH_SIZE).optional(),
  continueOnError: booleanValue.optional(),
});

export class EntraProvisionRequestDto extends createZodDto(EntraProvisionRequestSchema) {}
