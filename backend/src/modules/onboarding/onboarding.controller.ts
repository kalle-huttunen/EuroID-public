/**
 * REST API for onboarding workflows. Start workflow and query status via Temporal.
 */
import { Controller, Get, Param, Post, Body, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { OnboardingService } from './onboarding.service';
import { TriggerOnboardingDto } from './dtos/trigger-onboarding.dto';
import { getCurrentStepQuery } from '../../workflows/onboarding.workflow';
import { temporalWorkflowUrl } from '@infrastructure/config/temporal.config';
import { getTenantWorkflow } from '@infrastructure/temporal/tenant-workflow';
import { IdentityService } from '../identity/identity.service';

/** POST /onboarding/start for an email no identity of the tenant has. */
const NO_IDENTITY =
  'No identity has this email. Create the identity or run an HR sync first, then start onboarding.';

@ApiTags('Onboarding')
@ApiBearerAuth('jwt')
@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly identityService: IdentityService,
  ) {}

  /** The run's workflow id is built from the identity's id (`t-<tenant>-onboard-<identityId>`). */
  @Post('start')
  @Roles('operator')
  @ApiOperation({ summary: 'Start onboarding workflow for a new user' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 404, description: 'No identity of the tenant has this email' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async startWorkflow(@Body() body: TriggerOnboardingDto) {
    const identity = await this.identityService.findIdentityByEmail(body.email);
    if (!identity) throw new NotFoundException(NO_IDENTITY);
    const id = await this.onboardingService.triggerOnboarding({
      identityId: String(identity._id),
      email: body.email,
    });
    return {
      message: 'Onboarding Workflow Initiated',
      workflowId: id,
      email: body.email,
      trackingUrl: temporalWorkflowUrl(id),
    };
  }

  @Get('status/:workflowId')
  @Roles('operator')
  @ApiOperation({ summary: 'Get onboarding workflow status' })
  @ApiResponse({ status: 200, description: 'Current step and status of an onboarding workflow' })
  @ApiResponse({ status: 404, description: 'No such workflow in the caller tenant' })
  async getStatus(@Param('workflowId') workflowId: string) {
    // Another tenant's workflow id is a 404, like a missing one.
    const { handle, description } = await getTenantWorkflow(
      this.onboardingService.getTemporalClient(),
      workflowId,
    );

    // Query the live workflow to get its current step
    const currentStep = await handle.query(getCurrentStepQuery);

    return {
      workflowId,
      currentStep, // e.g., "HR_SYNC", "HUB_SAVE", "TARGET_PUSH"
      status: description.status.name, // RUNNING, COMPLETED, FAILED, etc.
      percent: this.calculatePercent(currentStep),
      startTime: description.startTime,
    };
  }

  /**
   * Helper method to convert workflow steps into progress bar percentages
   * This powers the visual progress bar in the frontend dashboard
   */
  private calculatePercent(step: string): number {
    const stepMap: Record<string, number> = {
      INITIALIZING: 5,
      DISCOVERING_SYSTEMS: 15,
      HEALTH_CHECK: 25,
      HR_SYNC: 40,
      HUB_SAVE: 55,
      POLICY_CALC: 70,
      TARGET_PUSH: 85,
      COMPLETED: 100,
    };
    return stepMap[step] || 0;
  }
}
