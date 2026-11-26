import { createHash } from 'crypto';
/**
 * ServiceNow Connector — Ticket integration and user sync.
 *
 * Implements IConnector. Creates/updates ServiceNow user records and
 * creates tracking incidents for provisioning events. Discovers
 * assignment groups as entitlements.
 *
 * Connector = dumb pipe: field mapping only, no business logic.
 */

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { IConnector } from '../connector.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ServiceNowConfig } from './servicenow.interface';
import { ServiceNowClient } from './servicenow.client';
import { ConnectorConfigService } from '../connector-config.service';
import { ConnectorConfigDecryptError } from '../connector-config.errors';
import type { DeprovisionResult } from '@shared/types/deprovision';
import { maskEmail } from '../../identity/identity-pii';

const CONNECTOR_ID = 'servicenow';
/** provision() returns `snow-<sys_id>` as the target user id. */
const TARGET_ID_PREFIX = 'snow-';

@Injectable()
export class ServiceNowService implements IConnector {
  private readonly logger = new Logger(ServiceNowService.name);

  constructor(
    private readonly client: ServiceNowClient,
    private readonly connectorConfig: ConnectorConfigService,
  ) {}

  /**
   * Create (provision) — creates/updates ServiceNow user record and
   * creates a tracking incident for the provisioning event.
   */
  async create(user: StandardUserDto, intent?: unknown): Promise<{ targetUserId: string }> {
    const cfg = await this.getConfig();
    return this.provision(cfg, user, intent);
  }

  /**
   * Discover — lists assignment groups as entitlements.
   */
  async discover(): Promise<Array<{ nativeId: string; name: string; type: string }>> {
    const cfg = await this.getConfig();
    const groups = await this.client.listAssignmentGroups(cfg);
    return groups.map((g) => ({
      nativeId: g.sys_id,
      name: g.name,
      type: 'assignment_group',
    }));
  }

  /**
   * Health check — verify connectivity to ServiceNow instance.
   */
  async healthCheck(config?: unknown): Promise<boolean> {
    let cfg: ServiceNowConfig;
    try {
      cfg = (config ?? (await this.getConfig())) as ServiceNowConfig;
    } catch (err: unknown) {
      // Not unhealthy: a process with the right key can read it (503, retried)
      if (err instanceof ConnectorConfigDecryptError) throw err;
      return false;
    }
    return this.client.healthCheck(cfg);
  }

  /**
   * Provision with explicit config (for activities/callers that pass config).
   */
  async provision(
    config: ServiceNowConfig,
    user: StandardUserDto,
    intent?: unknown,
  ): Promise<{ targetUserId: string }> {
    // Step 1: Create or update ServiceNow user record
    const existingUser = await this.client.getUser(config, user.email);
    const userFields = this.mapUserFields(user);
    let sysId: string;

    if (existingUser) {
      const updated = await this.client.updateUser(config, existingUser.sys_id, userFields);
      sysId = updated.sys_id;
      this.logger.log(`[PROVISION] Updated ServiceNow user ${maskEmail(user.email)} (${sysId})`);
    } else {
      const created = await this.client.createUser(config, userFields);
      sysId = created.sys_id;
      this.logger.log(`[PROVISION] Created ServiceNow user ${maskEmail(user.email)} (${sysId})`);
    }

    // Step 2: The tracking incident of this provisioning event, once: a retry of the activity
    // finds the open incident it created by its correlation_id (the record and the fields)
    const incidentFields = this.mapIncidentFields(config, user, intent);
    const correlationId = incidentCorrelationId(sysId, incidentFields);
    const open = await this.client.findOpenIncident(config, correlationId);
    if (open) {
      this.logger.log(`[PROVISION] Tracking incident ${open.number} is already open`);
    } else {
      const incident = await this.client.createIncident(config, {
        ...incidentFields,
        correlation_id: correlationId,
      });
      this.logger.log(
        `[PROVISION] Created tracking incident ${incident.number} for ${maskEmail(user.email)}`,
      );
    }

    return { targetUserId: `snow-${sysId}` };
  }

  /**
   * Deprovision: deactivate and lock the sys_user record (active=false, locked_out=true); the
   * record is never deleted. Finds it by the stored id (`snow-<sys_id>` or a sys_id), else by
   * the identifiers provisioning set: `email`, then `user_name` (both the email). A stored id
   * that is gone, with no record under those identifiers either, is already gone; with no
   * stored id, no record is a failure an admin must check (422, not retried). Two records with
   * one identifier are ambiguous (422); one already inactive and locked is already gone.
   */
  async deprovision(
    user: { externalId?: string; email: string },
    config?: ServiceNowConfig,
  ): Promise<DeprovisionResult> {
    const cfg = config ?? (await this.getConfig());
    const sysId = user.externalId?.startsWith(TARGET_ID_PREFIX)
      ? user.externalId.slice(TARGET_ID_PREFIX.length)
      : user.externalId;
    let record = sysId ? await this.client.getUserBySysId(cfg, sysId) : null;
    if (!record) record = await this.findByIdentifiers(cfg, user.email);
    if (!record && sysId) return { outcome: 'already-gone', detail: 'no sys_user record' };
    if (!record) {
      throw new ConnectorException(
        'No ServiceNow user has the email or user_name EuroID provisioned with, and no ' +
          'sys_id is stored: the record may exist under another name. Check ServiceNow, ' +
          'deactivate it there and mark it removed manually.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (record.active === 'false' && record.locked_out === 'true') {
      return { outcome: 'already-gone', detail: 'already inactive and locked' };
    }
    if (!(await this.client.deactivateUser(cfg, record.sys_id))) {
      return { outcome: 'already-gone', detail: 'no sys_user record' };
    }
    this.logger.log(`[DEPROVISION] Deactivated ServiceNow user ${record.sys_id}`);
    return { outcome: 'deprovisioned', detail: 'deactivated and locked' };
  }

  /** The one record whose email, else user_name, is `email`; two matches are ambiguous. */
  private async findByIdentifiers(cfg: ServiceNowConfig, email: string) {
    for (const field of ['email', 'user_name'] as const) {
      const matches = await this.client.findUsersBy(cfg, field, email);
      if (matches.length > 1) {
        throw new ConnectorException(
          `More than one ServiceNow user has this ${field}; deactivate the right one by hand`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (matches[0]) return matches[0];
    }
    return null;
  }

  // ── Field mapping (dumb pipe) ─────────────────────────

  private mapUserFields(user: StandardUserDto): Record<string, string> {
    const fields: Record<string, string> = {
      email: user.email,
      first_name: user.firstName,
      last_name: user.lastName,
      user_name: user.email,
      active: user.status === 'ACTIVE' ? 'true' : 'false',
    };
    // Deprovision locks the record as well; an active user (a rehire) is unlocked again
    if (user.status === 'ACTIVE') fields.locked_out = 'false';
    if (user.jobTitle) fields.title = user.jobTitle;
    if (user.departmentName) fields.department = user.departmentName;
    if (user.mobilePhone) fields.mobile_phone = user.mobilePhone;
    if (user.workPhone) fields.phone = user.workPhone;
    if (user.location) fields.location = user.location;
    if (user.employeeId) fields.employee_number = user.employeeId;
    return fields;
  }

  private mapIncidentFields(
    config: ServiceNowConfig,
    user: StandardUserDto,
    intent?: unknown,
  ): Record<string, string> {
    const intentObj = (intent ?? {}) as Record<string, string>;
    const operation = intentObj.operation ?? 'provision';
    const description = intentObj.description ?? `Identity provisioning event for ${user.email}`;

    const fields: Record<string, string> = {
      short_description: `[EuroID] ${operation}: ${user.firstName} ${user.lastName} (${user.email})`,
      description,
      priority: config.incidentPriority ?? '3',
      contact_type: 'Integration',
    };
    if (config.incidentCategory) fields.category = config.incidentCategory;
    if (config.defaultAssignmentGroup) fields.assignment_group = config.defaultAssignmentGroup;
    return fields;
  }

  // ── Config resolution ─────────────────────────────────

  private async getConfig(): Promise<ServiceNowConfig> {
    const doc = await this.connectorConfig.getConfig(CONNECTOR_ID);
    if (!doc?.config?.instanceUrl) {
      throw new ConnectorException(
        'ServiceNowConnector: not configured. Install with instanceUrl and auth credentials.',
      );
    }
    return doc.config as unknown as ServiceNowConfig;
  }
}

/**
 * The tracking incident's correlation_id: the sys_user record and a hash of the incident's
 * fields, so a retry of one provisioning event finds its own incident and a provisioning with
 * other data (another operation, changed names) gets a new one.
 */
function incidentCorrelationId(sysId: string, fields: Record<string, string>): string {
  const digest = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16);
  return `euroid-${sysId}-${digest}`;
}
