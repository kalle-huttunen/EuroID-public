import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiHeader,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { GdprErasureService } from './gdpr-erasure.service';
import { DsarExportService } from './dsar-export.service';
import { ConsentService } from './consent.service';
import { GrantConsentDto } from './dtos/grant-consent.dto';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';

/**
 * GDPR Compliance API (Articles 6, 15, 17, 20).
 * Mounted at /identity to preserve existing API paths.
 */
@ApiTags('Identity')
@ApiBearerAuth('jwt')
@Controller('identity')
export class GdprComplianceController {
  constructor(
    private readonly gdprErasureService: GdprErasureService,
    private readonly dsarExportService: DsarExportService,
    private readonly consentService: ConsentService,
  ) {}

  @Get('compliance/consent-report')
  @Roles('super-admin', 'operator')
  @ApiOperation({ summary: 'Aggregate consent status across all identities (GDPR Article 6)' })
  @ApiResponse({ status: 200, description: 'Consent report with per-purpose breakdown.' })
  async getConsentReport() {
    return this.consentService.getConsentReport();
  }

  @Delete(':id/gdpr-erase')
  @Roles('super-admin')
  @ApiOperation({
    summary: 'GDPR Right to Erasure (Article 17) — hard-delete identity and all related data',
  })
  @ApiResponse({ status: 200, description: 'Erasure attestation returned.' })
  @ApiResponse({ status: 404, description: 'Identity not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — requires super-admin and X-Confirm-Erasure header',
  })
  @ApiResponse({ status: 429, description: 'Too Many Requests — rate limit exceeded' })
  @ApiQuery({
    name: 'dryRun',
    required: false,
    type: Boolean,
    description: 'If true, returns what would be deleted without actually deleting',
  })
  @ApiHeader({
    name: 'X-Confirm-Erasure',
    required: false,
    description: 'Must be "true" for non-dry-run erasure',
  })
  async gdprErase(
    @Param('id', ParseObjectIdPipe) id: string,
    @Query('dryRun') dryRun?: string,
    @Headers('x-confirm-erasure') confirmHeader?: string,
    @AuthUser() authUser?: AuthUserType,
  ) {
    const isDryRun = dryRun === 'true';
    if (!isDryRun && confirmHeader !== 'true') {
      throw new ForbiddenException('GDPR erasure requires X-Confirm-Erasure: true header');
    }
    return this.gdprErasureService.eraseIdentity(id, authUser?.email ?? 'unknown', isDryRun);
  }

  @Get(':id/dsar-export')
  @Roles('super-admin', 'operator')
  @ApiOperation({
    summary: 'GDPR Data Subject Access Request (Articles 15 & 20) — export all data for identity',
  })
  @ApiResponse({ status: 200, description: 'DSAR export package (JSON).' })
  @ApiResponse({ status: 404, description: 'Identity not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires super-admin or operator role' })
  async dsarExport(
    @Param('id', ParseObjectIdPipe) id: string,
    @AuthUser() authUser?: AuthUserType,
  ) {
    return this.dsarExportService.exportIdentityData(id, authUser?.email ?? 'unknown');
  }

  @Post(':id/consent')
  @Roles('super-admin', 'operator')
  @ApiOperation({ summary: 'Record consent grant for an identity (GDPR Article 6)' })
  @ApiResponse({ status: 201, description: 'Consent recorded.' })
  @ApiResponse({ status: 400, description: 'Validation failed.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  async grantConsent(
    @Param('id', ParseObjectIdPipe) id: string,
    @Body() body: GrantConsentDto,
    @AuthUser() authUser?: AuthUserType,
  ) {
    return this.consentService.grantConsent(id, body, authUser?.email ?? 'unknown');
  }

  @Delete(':id/consent/:purpose')
  @Roles('super-admin', 'operator')
  @ApiOperation({ summary: 'Revoke consent for an identity + purpose (GDPR Article 6)' })
  @ApiResponse({ status: 200, description: 'Consent revoked.' })
  @ApiResponse({ status: 404, description: 'Consent not found.' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 403, description: 'Forbidden — insufficient role' })
  async revokeConsent(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('purpose') purpose: string,
  ) {
    return this.consentService.revokeConsent(id, purpose);
  }

  @Get(':id/consent')
  @Roles('super-admin', 'operator', 'viewer')
  @ApiOperation({ summary: 'List all consents for an identity (GDPR Article 6)' })
  @ApiResponse({ status: 200, description: 'List of consent records.' })
  async listConsents(@Param('id', ParseObjectIdPipe) id: string) {
    return this.consentService.listConsents(id);
  }
}
