/**
 * FileOutboundConnector — Config and types.
 *
 * Low-friction dev connector: appends provisioning intent to a local JSONL file.
 */

import { ProvisioningIntent } from '@shared/interfaces/provisioning.interface';

/** Configuration for FileOutboundConnector */
export interface FileOutboundConfig {
  /** Path to output file (e.g. ./provisioning-log.jsonl). Relative paths resolved against process cwd. */
  outputFilePath: string;
}

/** Payload written to file (one JSON line per provision) */
export interface FileOutboundPayload {
  timestamp: string;
  user: {
    email: string;
    firstName: string;
    lastName: string;
    jobTitle?: string;
    departmentName?: string;
  };
  intent?: ProvisioningIntent;
}
