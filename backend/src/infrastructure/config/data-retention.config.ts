import { registerAs } from '@nestjs/config';

export interface DataRetentionConfig {
  workflowRetentionDays: number;
  userEventsRetentionDays: number;
  auditRetentionDays: number;
  identitySoftDeleteRetentionDays: number;
}

export const dataRetentionConfig = registerAs(
  'dataRetention',
  (): DataRetentionConfig => ({
    workflowRetentionDays: parseInt(process.env.WORKFLOW_RETENTION_DAYS ?? '90', 10),
    userEventsRetentionDays: parseInt(process.env.USER_EVENTS_RETENTION_DAYS ?? '365', 10),
    auditRetentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS ?? '365', 10),
    identitySoftDeleteRetentionDays: parseInt(
      process.env.IDENTITY_SOFT_DELETE_RETENTION_DAYS ?? '30',
      10,
    ),
  }),
);
