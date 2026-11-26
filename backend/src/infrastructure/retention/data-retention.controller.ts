/**
 * Data Retention Controller
 *
 * Admin endpoints for retention policy enforcement.
 * POST /api/v1/dev/retention/purge-deleted — super-admin only.
 */

import { Controller, Get, Post, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { DataRetentionService } from './data-retention.service';

@ApiTags('Dev Tools')
@ApiBearerAuth('jwt')
@Controller('dev/retention')
export class DataRetentionController {
  private readonly logger = new Logger(DataRetentionController.name);

  constructor(private readonly dataRetentionService: DataRetentionService) {}

  @Post('purge-deleted')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Purge soft-deleted identities (hard delete after retention period)' })
  @ApiQuery({ name: 'retentionDays', required: false, type: Number, description: 'Override retention days (default: IDENTITY_SOFT_DELETE_RETENTION_DAYS)' })
  @ApiResponse({ status: 200, description: 'Purge completed.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires super-admin.' })
  async purgeDeleted(@Query('retentionDays') retentionDays?: string) {
    const days = retentionDays ? parseInt(retentionDays, 10) : undefined;
    if (days !== undefined && (isNaN(days) || days < 1)) {
      return { success: false, error: 'retentionDays must be a positive number' };
    }
    const result = await this.dataRetentionService.purgeDeletedIdentities(days);
    this.logger.log(`[Retention] Purged ${result.usersPurged} users, ${result.identitiesPurged} identities (cutoff: ${result.cutoffDate.toISOString()})`);
    return { success: true, ...result };
  }

  @Post('dry-run')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Dry-run: report what would be purged without deleting' })
  @ApiQuery({ name: 'retentionDays', required: false, type: Number, description: 'Override retention days' })
  @ApiResponse({ status: 200, description: 'Dry-run report.' })
  async dryRun(@Query('retentionDays') retentionDays?: string) {
    const days = retentionDays ? parseInt(retentionDays, 10) : undefined;
    if (days !== undefined && (isNaN(days) || days < 1)) {
      return { success: false, error: 'retentionDays must be a positive number' };
    }
    return this.dataRetentionService.runRetentionChecks(days);
  }

  @Get('config')
  @Roles('viewer')
  @ApiOperation({ summary: 'Get current retention configuration from env' })
  @ApiResponse({ status: 200, description: 'Retention config.' })
  async getConfig() {
    return this.dataRetentionService.getRetentionConfig();
  }
}
