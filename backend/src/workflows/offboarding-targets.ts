/**
 * Which deprovision path offboarding takes for a target system name (as stored in
 * identity.provisioning: canvas node types such as 'entra', 'okta', 'file-outbound').
 * Pure and deterministic: imported by the offboarding workflow.
 */
import { getSystemType, normalizeSystemName } from '../shared/utils/normalize-system-name';

export type OffboardingTargetKind =
  | 'entra'
  | 'ad'
  | 'scim'
  | 'okta'
  | 'github'
  | 'servicenow'
  | 'not-applicable'
  | 'unknown';

/**
 * Targets that keep no account: Discord webhook (posts a message), Google Sheets (appends a row),
 * File outbound (writes a file). Offboarding reports them "not applicable". Normalized names.
 */
export const NO_ACCOUNT_TARGETS: readonly string[] = [
  'discordwebhook',
  'googlesheets',
  'fileoutbound',
];

const ACCOUNT_TARGETS = new Set(['scim', 'okta', 'github', 'servicenow']);

export function offboardingTargetKind(system: string): OffboardingTargetKind {
  const type = getSystemType(system);
  if (type !== 'unknown') return type;
  const name = normalizeSystemName(system);
  if (ACCOUNT_TARGETS.has(name)) return name as OffboardingTargetKind;
  if (NO_ACCOUNT_TARGETS.includes(name)) return 'not-applicable';
  return 'unknown';
}
