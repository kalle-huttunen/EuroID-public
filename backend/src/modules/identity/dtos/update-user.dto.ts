import { createZodDto } from '@anatine/zod-nestjs';
import { StandardUserSchema } from '@shared/dtos/standard-user.dto';

/**
 * PATCH /identity/:id body. `tenantId` is not accepted (the request context decides the tenant),
 * nor are the actor fields `createdBy` and `updatedBy` (the authenticated user is the actor).
 */
export const UpdateUserSchema = StandardUserSchema.omit({ tenantId: true })
  .omit({ createdBy: true, updatedBy: true })
  .partial();
export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
