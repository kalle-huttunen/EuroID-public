/**
 * Compliance Reporting Controller
 *
 * REST API for SOX and ISO 27001 compliance report generation.
 */

import { Controller, Get, Post, Param, Query, Body, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AuthUser } from '@infrastructure/auth/auth-user.decorator';
import type { AuthUser as AuthUserType } from '@infrastructure/auth/auth-user.decorator';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { ComplianceReportingService } from './compliance-reporting.service';
import { GenerateReportBodyDto } from './dtos/generate-report.dto';
import type { ReportType } from './schemas/report-metadata.schema';

@ApiTags('Compliance Reports')
@ApiBearerAuth('jwt')
@Controller('compliance-reports')
export class ComplianceReportingController {
  constructor(private readonly complianceService: ComplianceReportingService) {}

  @Post('generate')
  @Roles('policy-admin', 'super-admin')
  @ApiOperation({ summary: 'Generate SOX or ISO 27001 compliance report' })
  async generate(@Body() body: GenerateReportBodyDto, @AuthUser() authUser?: AuthUserType) {
    const generatedBy = authUser?.email ?? 'system';
    return this.complianceService.generateReport(
      body.type,
      body.dateRange,
      body.format,
      generatedBy,
    );
  }

  @Get()
  @Roles('policy-admin', 'super-admin')
  @ApiOperation({ summary: 'List generated compliance reports' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by report type (SOX, ISO27001)' })
  async list(@Query('type') type?: ReportType) {
    const tenantId = getCurrentTenantId();
    return this.complianceService.listReports(tenantId, type ? { type } : undefined);
  }

  @Get(':id/download')
  @Roles('policy-admin', 'super-admin')
  @ApiOperation({ summary: 'Download report file' })
  async download(@Param('id') reportId: string, @Res() res: Response) {
    const { buffer, format } = await this.complianceService.getReport(reportId);
    const ext = format === 'PDF' ? 'pdf' : 'csv';
    const contentType = format === 'PDF' ? 'application/pdf' : 'text/csv';
    const filename = `compliance-report-${reportId}.${ext}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
