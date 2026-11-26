import { registerAs } from '@nestjs/config';
import { resolve } from 'path';

export interface ComplianceConfig {
  reportsPath: string;
}

export const complianceConfig = registerAs(
  'compliance',
  (): ComplianceConfig => ({
    reportsPath: process.env.COMPLIANCE_REPORTS_PATH ?? resolve(process.cwd(), 'reports'),
  }),
);
