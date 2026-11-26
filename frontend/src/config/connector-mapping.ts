/** Map connector display name to backend target system id */
export const CONNECTOR_NAME_TO_ID: Record<string, string> = {
  'Microsoft Entra ID': 'entra-id',
};

/**
 * Target systems bulk provisioning can execute (the per-system switch in
 * backend/src/activities/bulk-provisioning.activities.ts). Any other target
 * fails there with "Unknown system".
 */
export const BULK_TARGET_SYSTEM_IDS: readonly string[] = [
  'entra-id',
  'file-outbound',
  'discord-webhook',
  'github',
  'google-sheets',
];
