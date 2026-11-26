import { registerAs } from '@nestjs/config';

export interface AccessRequestsConfig {
  approvalTimeoutDays: number;
}

export const accessRequestsConfig = registerAs(
  'accessRequests',
  (): AccessRequestsConfig => ({
    approvalTimeoutDays: parseInt(process.env.ACCESS_REQUEST_APPROVAL_TIMEOUT_DAYS ?? '7', 10),
  }),
);
