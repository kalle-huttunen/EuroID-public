import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';

/** refresh_token optional when sent via httpOnly cookie (FA-1). API clients pass in body. */
export const RefreshTokenSchema = z.object({
  refresh_token: z.string().optional(),
});

export class RefreshTokenDto extends createZodDto(RefreshTokenSchema) {}
