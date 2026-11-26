/**
 * REST API for batch provisioning: seed test users, trigger Entra provisioning, monitor progress, cleanup.
 */

import { Controller, Post, Get, Param, Query, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Public } from '@infrastructure/auth/public.decorator';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { PLATFORM_ADMIN_ROLE } from '@infrastructure/auth/platform-admin';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { BatchProvisionService } from './batch-provision.service';
import { SeedRequestDto, EntraProvisionRequestDto } from './batch-provision.dtos';

@ApiTags('Batch Provisioning')
@ApiBearerAuth('jwt')
@Controller('batch-provision')
export class BatchProvisionController {
  private readonly logger = new Logger(BatchProvisionController.name);

  constructor(
    private readonly batchProvisionService: BatchProvisionService,
  ) {}

  /**
   * Diagnose where the app looks for .env (same order as app.module).
   */
  private getEnvLoadInfo() {
    const backendDir = resolve(__dirname, '..', '..', '..');
    const envInBackend = resolve(backendDir, '.env');
    const envInCwd = resolve(process.cwd(), '.env');
    const envInCwdBackend = resolve(process.cwd(), 'backend', '.env');
    const attempted = [
      { path: envInBackend, exists: existsSync(envInBackend) },
      { path: envInCwd, exists: existsSync(envInCwd) },
      { path: envInCwdBackend, exists: existsSync(envInCwdBackend) },
    ];
    const firstExisting = attempted.find((p) => p.exists)?.path ?? null;
    return {
      processCwd: process.cwd(),
      dirname: __dirname,
      attemptedPaths: attempted,
      firstExisting,
    };
  }

  /** Intentional @Public(): load balancers need unauthenticated health check. */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Batch-provision health check (status, env, Temporal)' })
  async healthCheck() {
    return this.batchProvisionService.getHealthCheck();
  }

  // Deployment-wide (process paths, env key status, the shared Entra app): platform admin only.
  @Get('health/diagnostics')
  @Roles(PLATFORM_ADMIN_ROLE)
  @ApiOperation({ summary: 'Full diagnostics (env paths, keys, Entra) — platform-admin only' })
  async healthDiagnostics() {
    return this.batchProvisionService.getHealthDiagnostics(this.getEnvLoadInfo());
  }

  @Post('seed')
  @Roles('operator')
  @ApiOperation({ summary: 'Seed test users into MongoDB' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async seedTestUsers(@Body() body: SeedRequestDto) {
    return this.batchProvisionService.seedTestUsers(body.count || 10, body.domain);
  }

  @Post('entra')
  @Roles('operator')
  @ApiOperation({ summary: 'Trigger Entra provisioning for test-batch users (default dry-run)' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async triggerEntraProvisioning(
    @Query('dryRun') dryRunParam?: string,
    @Body() body?: EntraProvisionRequestDto,
  ) {
    const dryRun = dryRunParam !== 'false';
    return this.batchProvisionService.triggerEntraProvisioning({
      dryRun,
      batchSize: body?.batchSize,
      continueOnError: body?.continueOnError,
    });
  }

  @Get('status/:workflowId')
  @Roles('operator')
  @ApiOperation({ summary: 'Get batch provisioning workflow status' })
  async getProvisioningStatus(@Param('workflowId') workflowIdParam: string) {
    return this.batchProvisionService.getProvisioningStatus(workflowIdParam);
  }

  @Post('cleanup')
  @Roles('operator')
  @ApiOperation({ summary: 'Clean up test-batch users from MongoDB (optionally from Entra)' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  async cleanupTestUsers(@Query('fromEntra') fromEntraParam?: string) {
    const removeFromEntra = fromEntraParam === 'true';
    return this.batchProvisionService.cleanupTestUsers(removeFromEntra);
  }
}
