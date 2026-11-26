import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

export const RegisterAgentSchema = z.object({
  name: z.string().min(1).max(200),
  connectorTypes: z.array(z.string().max(100)).max(20).default([]),
  taskQueue: z.string().min(1).max(200),
  version: z.string().max(50).optional(),
  metadata: z.record(z.string().max(100), z.unknown()).optional(),
  certificate: z.string().max(10000).optional(),
});

export class RegisterAgentDto extends createZodDto(RegisterAgentSchema) {}

export const HeartbeatSchema = z.object({
  status: z.enum(['online', 'degraded']).default('online'),
  version: z.string().max(50).optional(),
  metadata: z.record(z.string().max(100), z.unknown()).optional(),
});

export class HeartbeatDto extends createZodDto(HeartbeatSchema) {}
