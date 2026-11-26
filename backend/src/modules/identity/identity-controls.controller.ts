import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import {
  UpdateIdentityControlsDto,
  UpdateIdentityControlsSchema,
} from './dtos/update-identity-controls.dto';
import { IdentityControlsService } from './identity-controls.service';
import { MaskPiiInterceptor } from './mask-pii.interceptor';

/**
 * Identity controls (the admin layer of the onion) and who masters each profile field. Since
 * 2026-11-24 PATCH /identity/:id refuses an edit of a field an HR source masters (409); the
 * attribute controls here are the one override of an HR-mastered department or job title
 * (attribute-controls.ts). Tenant and actor from the authenticated user. Responses mask PII
 * fields (MaskPiiInterceptor), as IdentityController's.
 */
@ApiTags('Identity')
@ApiBearerAuth('jwt')
@Controller('identity')
@UseInterceptors(MaskPiiInterceptor)
export class IdentityControlsController {
  constructor(private readonly controls: IdentityControlsService) {}

  @Patch('v2/:id/controls')
  @Roles('operator')
  @ApiOperation({
    summary:
      'Update Identity controls: Deny Login, email override, department and job title overrides',
  })
  @ApiBody({ type: UpdateIdentityControlsDto })
  @ApiResponse({
    status: 200,
    description:
      '{ success: true, identity }: controls updated and profile reconciled. manualDepartment ' +
      'and manualJobTitle override the HR-mastered department and job title in the profile and ' +
      'in the policy contracts until removed ("" or null) or until expiresAt passes (the hourly ' +
      'expiry run ends them); setting one needs a reason. A change of the profile department ' +
      'or title emits identity.updated, which starts the mover (or onboarding). Each set, ' +
      'removal and expiry is audited (IDENTITY_CONTROL_SET, _REMOVED, _EXPIRED), as are the ' +
      'kill switch (IDENTITY_LOGIN_DISABLED, _ENABLED) and the email override ' +
      '(IDENTITY_EMAIL_OVERRIDE_SET, _REMOVED, the address masked).',
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid body: unknown field, a control set without reason, expiresAt in the past or ' +
      'without a control being set, an email override that is no email. One message per field.',
  })
  @ApiResponse({ status: 404, description: 'Identity not found.' })
  @ApiResponse({
    status: 409,
    description: 'Nothing was changed: the email override is the email of another live identity.',
  })
  @ApiResponse({
    status: 503,
    description: 'The correlation settings could not be read: nothing was stored. Try again.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async updateIdentityControls(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: unknown,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const update = UpdateIdentityControlsSchema.parse(body ?? {});
    const identity = await this.controls.updateControls(
      id,
      update,
      authUser?.email || authUser?.sub,
    );
    if (!identity) throw new NotFoundException('Identity not found');
    return { success: true, identity: identity.toObject() };
  }

  @Get(':id/mastery')
  @Roles('viewer')
  @ApiOperation({
    summary: 'Which HR source masters each profile field of the identity, and its active overrides',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ identityId, masteredBy: { <field>: <HR source> }, attributeControls: { departmentName?, ' +
      'jobTitle?: { value, reason, setBy, setAt, expiresAt } } }. A field in masteredBy is the ' +
      "HR source's (PATCH /identity/:id refuses to change it); a field not listed is kept by " +
      'EuroID and can be edited.',
  })
  @ApiResponse({ status: 404, description: 'Identity not found.' })
  async getMastery(@Param('id', ParseObjectIdPipe) id: string) {
    const mastery = await this.controls.getMastery(id);
    if (!mastery) throw new NotFoundException('Identity not found');
    return mastery;
  }
}
