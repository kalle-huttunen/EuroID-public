import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { HrFetchStats } from '../hr-lifecycle-fields';

/**
 * Optional interface for HR connectors that support write-back.
 * When Entra ID generates an email, the Brain can push it back to the HR system.
 * Not all HR connectors support this (e.g., CSV/JSON feeds are read-only).
 *
 * @see docs/tasks/CURRENT_TASK_80.md
 */
export interface IHrConnectorWriteBack {
  /**
   * Update specific fields on an existing user in the HR system.
   * @param externalId - The HR system's user identifier (e.g., employee ID)
   * @param fields - Field names to values (only write-back-eligible fields)
   */
  updateUserFields(
    externalId: string,
    fields: Record<string, unknown>,
    config: Record<string, unknown>,
    tenantId?: string,
  ): Promise<{ success: boolean; updatedFields: string[]; reason?: string }>;

  /** Which fields this HR connector supports writing back (e.g., ['email', 'workPhone']). */
  readonly writeBackCapableFields: string[];
}

/**
 * Interface for inbound HR data sources.
 * Plugins implementing this interface feed user data into the Identity Hub.
 * The Hub merges data from multiple IHrConnector instances via survivorship rules.
 *
 * HR connectors use `sourceName` for `sourceSystem` in identity.sources.
 */
export interface IHrConnector {
  /**
   * Fetch users from the HR source.
   * Returns partial StandardUserDto — the Hub fills defaults and merges.
   * @param config Connector-specific config (e.g., filePath, url)
   * @param tenantId Optional tenant filter
   * @param stats When given, the connector counts rows it read but could not map in `stats.skipped`
   */
  fetchUsers(
    config: Record<string, unknown>,
    tenantId?: string,
    stats?: HrFetchStats,
  ): Promise<Partial<StandardUserDto>[]>;

  /**
   * Human-readable source name for survivorship (e.g., "csv-hr", "json-api-hr").
   * Used as sourceSystem in linked accounts.
   */
  readonly sourceName: string;

  /**
   * Health check — verify the source is reachable.
   */
  healthCheck?(config: Record<string, unknown>): Promise<boolean>;
}

/**
 * What POST /connectors/:name/health-check answers for an HR source (checkSource of csv-hr and
 * json-api-hr): what was checked when healthy, else why not. A message names a setting, an HTTP
 * status, a network error code or a parse failure, never a credential or the source's content.
 */
export interface HrSourceCheck {
  healthy: boolean;
  message?: string;
  error?: string;
}
