import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

const CONNECTOR_CONFIG_MAX_KEYS = 50;
const CONNECTOR_CONFIG_MAX_VALUE_LEN = 2000;

const ConnectorConfigRecordSchema = z
  .record(z.string().max(CONNECTOR_CONFIG_MAX_VALUE_LEN))
  .refine((val) => Object.keys(val).length <= CONNECTOR_CONFIG_MAX_KEYS, {
    message: `config cannot exceed ${CONNECTOR_CONFIG_MAX_KEYS} keys (F4)`,
  });

export const InstallConnectorSchema = z.object({
  config: ConnectorConfigRecordSchema,
  ingestPriority: z.number().int().positive().optional(),
  contractTag: z.enum(['PRIMARY', 'SECONDARY']).optional(),
  masteryFields: z.array(z.string().min(1)).optional(),
});
export class InstallConnectorDto extends createZodDto(InstallConnectorSchema) {}

export const UpdateConnectorSchema = z.object({
  config: ConnectorConfigRecordSchema.optional(),
  ingestPriority: z.number().int().positive().optional(),
  contractTag: z.enum(['PRIMARY', 'SECONDARY']).optional(),
  masteryFields: z.array(z.string().min(1)).optional(),
});
export class UpdateConnectorDto extends createZodDto(UpdateConnectorSchema) {}
