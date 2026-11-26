import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { SCIM_SCOPES } from '../guards/scim-auth.guard';

export const CreateScimTokenSchema = z.object({
  name: z.string(),
  /** Default: all four. An unknown scope is a 400: no route would ever accept it. */
  scopes: z.array(z.enum(SCIM_SCOPES)).optional(),
  expiresAt: z.string().optional(),
});

export class CreateScimTokenDto extends createZodDto(CreateScimTokenSchema) {}
