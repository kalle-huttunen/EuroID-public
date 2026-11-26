import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { AccessReevaluationService } from './access-reevaluation.service';

/** The re-evaluation takes no input: tenant, actor and identity come from the request. */
const ReevaluateAccessSchema = z.object({}).strict();

/**
 * An identity's access changes (2.2): preview what re-evaluating its access would add and
 * remove, and start that re-evaluation (the mover workflow). Same roles as the identity
 * endpoints: reads for viewer, writes for operator. Tenant from the authenticated user.
 */
@ApiTags('Identity')
@ApiBearerAuth('jwt')
@Controller('identity')
export class AccessReevaluationController {
  constructor(private readonly reevaluation: AccessReevaluationService) {}

  @Get(':id/access/preview')
  @Roles('viewer')
  @ApiOperation({
    summary:
      'Access preview: entitlements a re-evaluation would add and remove (read-only, no workflow)',
  })
  @ApiResponse({ status: 200, description: 'The preview (AccessPreview).' })
  @ApiResponse({ status: 404, description: 'Identity not found in this tenant.' })
  async preview(@Param('id', ParseObjectIdPipe) id: string) {
    return this.reevaluation.preview(id);
  }

  @Post(':id/access/re-evaluate')
  @HttpCode(202)
  @Roles('operator')
  @ApiOperation({
    summary: 'Re-evaluate access: start the mover workflow for what the preview shows',
  })
  @ApiResponse({ status: 202, description: 'Started: { workflowId, changedFields }.' })
  @ApiResponse({ status: 400, description: 'A request body with fields.' })
  @ApiResponse({ status: 403, description: 'Forbidden: requires operator' })
  @ApiResponse({ status: 404, description: 'Identity not found in this tenant.' })
  @ApiResponse({
    status: 409,
    description: 'No access baseline, no provisioned target, or a mover run in progress.',
  })
  async reevaluate(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: unknown,
    @AuthUser() user: AuthUserType,
  ) {
    ReevaluateAccessSchema.parse(body ?? {});
    return this.reevaluation.reevaluate(id, user.email || user.sub);
  }
}
