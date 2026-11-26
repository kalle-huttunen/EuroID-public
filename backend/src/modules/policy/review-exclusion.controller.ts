import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { ReviewExclusionService } from './review-exclusion.service';

/**
 * Access review exclusions (review-exclusion.service.ts): an identity's active exclusions next
 * to its other access routes (/identity/:id/access/...), readable as the Access tab is (viewer),
 * and the exclusion counts per granting policy with the policies (/policy/...). Lifting one is
 * in the mover module (ReviewExclusionLiftController), since it starts a re-evaluation. Tenant
 * from the authenticated user.
 */
@ApiBearerAuth('jwt')
@Controller()
export class ReviewExclusionController {
  constructor(private readonly exclusions: ReviewExclusionService) {}

  @Get('identity/:id/access/review-exclusions')
  @ApiTags('Identity')
  @Roles('viewer')
  @ApiOperation({
    summary:
      'Active access review exclusions of an identity: revoked access the policies no longer grant',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ identityId, exclusions[] }: system, scope (entitlement or account), entitlement, ' +
      'campaign, decision, reviewer, justification, decidedAt, createdAt, grantingPolicies.',
  })
  @ApiResponse({ status: 400, description: 'The identity id is not an ObjectId.' })
  @ApiResponse({ status: 404, description: 'Identity not found in this tenant.' })
  async list(@Param('id', ParseObjectIdPipe) id: string) {
    return this.exclusions.listActive(id);
  }

  @Get('policy/review-exclusions/counts')
  @ApiTags('Policy Engine')
  @Roles('viewer')
  @ApiOperation({
    summary: 'Access review exclusions per granting policy: how often reviewers revoked its grants',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ counts: [{ policyId, policyName, active, lifted }] }, one row per policy with at ' +
      'least one exclusion.',
  })
  async countsByPolicy() {
    return { counts: await this.exclusions.countsByPolicy() };
  }
}
