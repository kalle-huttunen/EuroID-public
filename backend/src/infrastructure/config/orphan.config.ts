import { registerAs } from '@nestjs/config';

export interface OrphanConfig {
  gracePeriodDays: number;
  /**
   * ORPHAN_EXCLUDED_ACCOUNTS: the UPNs or mail addresses of accounts orphan detection never
   * quarantines (break-glass admins, service accounts, shared mailboxes), lower-cased. An entry
   * may hold `*` for any text (`svc-*@corp.example`). Comma-separated; applies to every tenant
   * and target system.
   */
  excludedAccounts: string[];
}

export const orphanConfig = registerAs(
  'orphan',
  (): OrphanConfig => ({
    gracePeriodDays: parseInt(process.env.ORPHAN_GRACE_PERIOD_DAYS ?? '30', 10),
    excludedAccounts: (process.env.ORPHAN_EXCLUDED_ACCOUNTS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  }),
);
