import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { ExpiryRemovedManuallySchema, RetryExpirySchema } from './dtos/access-expiry.dto';
import { IdentityAccessExpiryService } from './identity-access-expiry.service';

/** The audited actor of an admin action: the authenticated user, never the request body. */
function actorOf(user: AuthUserType): string {
  return user.email || user.sub;
}

/**
 * Expired access the hourly expiry run could not remove (`provisioning[].expiryFailure`): retry
 * it after fixing the cause (operator, like the identity writes), or close it after removing the
 * access by hand (policy-admin, like closing a failed offboarding target: it asserts a removal
 * EuroID cannot verify). Next to the identity's other access routes (/identity/:id/access/...).
 * Tenant from the authenticated user. Both answer the provisioning entry after the change.
 */
@ApiTags('Identity')
@ApiBearerAuth('jwt')
@Controller('identity')
export class IdentityAccessExpiryController {
  constructor(private readonly expiry: IdentityAccessExpiryService) {}

  @Post(':id/access/expiry/retry')
  @HttpCode(200)
  @Roles('operator')
  @ApiOperation({
    summary: 'Retry removing expired access: clears the expiry failure for the next hourly run',
  })
  @ApiResponse({ status: 200, description: 'The provisioning entry, without expiryFailure.' })
  @ApiResponse({ status: 400, description: 'Missing targetSystem, or other fields in the body.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires operator' })
  @ApiResponse({
    status: 404,
    description: 'Identity not found in this tenant, or no entry for targetSystem.',
  })
  @ApiResponse({
    status: 409,
    description: 'The entry has no failed expiry (or changed meanwhile).',
  })
  async retry(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: unknown,
    @AuthUser() user: AuthUserType,
  ) {
    const { targetSystem } = RetryExpirySchema.parse(body ?? {});
    return this.expiry.retry(id, targetSystem, actorOf(user));
  }

  @Post(':id/access/expiry/removed-manually')
  @HttpCode(200)
  @Roles('policy-admin')
  @ApiOperation({
    summary: 'Close failed expired access: an admin removed it in the target by hand',
  })
  @ApiResponse({ status: 200, description: 'The provisioning entry, now DEPROVISIONED.' })
  @ApiResponse({ status: 400, description: 'Missing targetSystem or reason, or other fields.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  @ApiResponse({
    status: 404,
    description: 'Identity not found in this tenant, or no entry for targetSystem.',
  })
  @ApiResponse({
    status: 409,
    description: 'The entry has no failed expiry (or changed meanwhile).',
  })
  async markRemovedManually(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: unknown,
    @AuthUser() user: AuthUserType,
  ) {
    const { targetSystem, reason } = ExpiryRemovedManuallySchema.parse(body ?? {});
    return this.expiry.markRemovedManually(id, targetSystem, actorOf(user), reason);
  }
}
