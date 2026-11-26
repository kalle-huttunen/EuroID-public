import { createZodDto } from '@anatine/zod-nestjs';
import { z } from 'zod';
import { ADMIN_ROLES } from '../schemas/admin-user.schema';

export const UpdateAdminSchema = z.object({
  isActive: z.boolean().optional(),
  /** One of the five tenant roles; platform-admin is not one (deployment configuration only). */
  role: z.enum(ADMIN_ROLES).optional(),
});

export class UpdateAdminDto extends createZodDto(UpdateAdminSchema) {}
