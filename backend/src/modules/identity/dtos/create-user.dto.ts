import { createZodDto } from '@anatine/zod-nestjs';
import { StandardUserSchema } from '@shared/dtos/standard-user.dto';

/**
 * POST /identity body: the golden record without `tenantId` and without the actor fields. The
 * tenant comes from the authenticated request context and `createdBy` from the authenticated
 * user; a `tenantId`, `createdBy` or `updatedBy` in the body is stripped by Zod.
 */
export const CreateUserSchema = StandardUserSchema.omit({ tenantId: true }).omit({
  createdBy: true,
  updatedBy: true,
});
export class CreateUserDto extends createZodDto(CreateUserSchema) {}
