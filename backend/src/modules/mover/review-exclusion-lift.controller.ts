import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { ReviewExclusionLiftService } from './review-exclusion-lift.service';

/** A lift takes no input: tenant, actor, identity and exclusion come from the request. */
const LiftReviewExclusionSchema = z.object({}).strict();

/**
 * Lifting an access review exclusion (ReviewExclusionLiftService): policy-admin, as the policies
 * it gives way to, next to the identity's other access routes. Here in the mover module because
 * the lift starts the identity's re-evaluation (an account exclusion: onboarding); listing
 * exclusions and the counts per policy are in the policy module (ReviewExclusionController).
 * Tenant from the authenticated user.
 */
@ApiTags('Identity')
@ApiBearerAuth('jwt')
@Controller('identity')
export class ReviewExclusionLiftController {
  constructor(private readonly lifts: ReviewExclusionLiftService) {}

  @Post(':id/access/review-exclusions/:exclusionId/lift')
  @HttpCode(200)
  @Roles('policy-admin')
  @ApiOperation({
    summary: 'Lift an access review exclusion and start the run that gives the access back',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ exclusion, run }: the exclusion, now status lifted (liftedBy, liftedAt); run.type ' +
      'reevaluation (an entitlement) or onboarding (an account), with started: true and ' +
      'workflowId, or started: false and the reason (the lift stays done).',
  })
  @ApiResponse({
    status: 400,
    description: 'An id that is not an ObjectId, or a request body with fields.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden: requires policy-admin' })
  @ApiResponse({
    status: 404,
    description: 'No exclusion with this id for the identity in this tenant.',
  })
  @ApiResponse({ status: 409, description: 'The exclusion was already lifted.' })
  async lift(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('exclusionId', ParseObjectIdPipe) exclusionId: string,
    @Body() body: unknown,
    @AuthUser() user: AuthUserType,
  ) {
    LiftReviewExclusionSchema.parse(body ?? {});
    return this.lifts.lift(id, exclusionId, user.email || user.sub);
  }
}
