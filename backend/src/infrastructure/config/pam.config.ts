import { registerAs } from '@nestjs/config';

export interface PamConfig {
  tier0MaxHours: number;
  tier1MaxHours: number;
  tier2MaxHours: number;
  /**
   * Admin account UPN. Placeholders `{firstName}`, `{lastName}`, `{domain}` and `{tier}` (t0, t1,
   * t2): without `{tier}` a person can have one admin account only (admin-upn.ts).
   */
  adminUpnPattern: string;
  /** Highest numeric suffix tried when another person's identity holds the admin UPN. */
  adminUpnMaxSuffix: number;
  /**
   * How long activate and deactivate wait for the privileged session's outcome before they
   * answer 202 (the session goes on; the Privileged access page shows its outcome).
   */
  activationWaitMs: number;
  /** Disable-only runs the hourly sweep starts per tenant for admin accounts of unknown state. */
  standingStateSweepLimit: number;
  /**
   * Days an Okta admin account may wait for its owner's activation (PROVISIONED) before the
   * hourly sweep raises admin_account.activation_pending, once.
   */
  activationPendingAlertDays: number;
}

export const pamConfig = registerAs(
  'pam',
  (): PamConfig => ({
    tier0MaxHours: parseInt(process.env.PAM_TIER0_MAX_HOURS ?? '8', 10),
    tier1MaxHours: parseInt(process.env.PAM_TIER1_MAX_HOURS ?? '24', 10),
    tier2MaxHours: parseInt(process.env.PAM_TIER2_MAX_HOURS ?? '72', 10),
    adminUpnPattern: process.env.ADMIN_UPN_PATTERN ?? 'adm-{firstName}.{lastName}@{domain}',
    adminUpnMaxSuffix: parseInt(process.env.ADMIN_UPN_MAX_SUFFIX ?? '20', 10),
    activationWaitMs: parseInt(process.env.PAM_ACTIVATION_WAIT_MS ?? '15000', 10),
    standingStateSweepLimit: parseInt(process.env.PAM_STANDING_STATE_SWEEP_LIMIT ?? '50', 10),
    activationPendingAlertDays: parseInt(process.env.PAM_ACTIVATION_PENDING_ALERT_DAYS ?? '7', 10),
  }),
);
