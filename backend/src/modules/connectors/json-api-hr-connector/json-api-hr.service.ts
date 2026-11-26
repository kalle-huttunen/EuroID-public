import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  IHrConnector,
  IHrConnectorWriteBack,
  type HrSourceCheck,
} from '../hr/interfaces/hr-connector.interface';
import { StandardUserDto, UserStatus, EmploymentType } from '@shared/dtos/standard-user.dto';
import { CONNECTOR_HEALTH_TIMEOUT_MS } from '@infrastructure/config/defaults';
import { JsonApiHrClient } from './json-api-hr.client';
import { assertSafeResponsePath, feedFailure, feedItems, messageOf } from './json-api-hr.feed';
import {
  DEFAULT_JSON_FIELD_MAP,
  type JsonApiHrAuth,
  type JsonApiHrConfig,
} from './json-api-hr.interface';
import { applyHrLifecycleFields, type HrFetchStats } from '../hr/hr-lifecycle-fields';
import { applyMappedCustomAttributes } from '../hr/hr-custom-attributes';
import { parseHrFieldMap } from '../hr/hr-field-map';

@Injectable()
export class JsonApiHrService implements IHrConnector, IHrConnectorWriteBack {
  readonly sourceName = 'json-api-hr';
  readonly writeBackCapableFields: string[] = [];
  private readonly logger = new Logger(JsonApiHrService.name);

  constructor(private readonly client: JsonApiHrClient) {}

  async fetchUsers(
    config: Record<string, unknown>,
    tenantId?: string,
    stats?: HrFetchStats,
  ): Promise<Partial<StandardUserDto>[]> {
    const {
      url,
      method,
      fieldMap,
      responsePath,
      sourceSystem,
      tenantId: configTenantId,
    } = config as unknown as JsonApiHrConfig;
    // When neither caller nor connector config provides tenantId, use DEFAULT_TENANT_ID for backward compatibility.
    const effectiveTenantId =
      tenantId ?? configTenantId ?? (process.env.DEFAULT_TENANT_ID || 'default');
    const effectiveSourceSystem = sourceSystem ?? this.sourceName;
    // JSON text as the API stores it, or an object; a wrong map fails the run with a 400
    const effectiveFieldMap = parseHrFieldMap(fieldMap, 'fieldMap') ?? DEFAULT_JSON_FIELD_MAP;

    if (!url || typeof url !== 'string') {
      throw new BadRequestException('JsonApiHrConnector: url is required');
    }

    assertSafeResponsePath(responsePath);
    const auth = this.resolveAuth(config as unknown as JsonApiHrConfig);
    const data = await this.client.fetch({ url, method, auth });
    const items = feedItems(data, responsePath);

    const users: Partial<StandardUserDto>[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (typeof item !== 'object' || item === null) {
        if (stats) stats.skipped++;
        this.logger.warn(`JsonApiHrConnector: Skipping row ${i + 1} (not an object)`);
        continue;
      }
      const mapped = this.mapItemToUser(
        item as Record<string, unknown>,
        effectiveFieldMap,
        effectiveSourceSystem,
        effectiveTenantId,
      );
      if (mapped) {
        users.push(mapped);
        stats?.sourceRows?.push(i + 1);
      } else {
        if (stats) stats.skipped++;
        // Names only, no values: safeLog redacts by key and misses headers such as "First Name"
        this.logger.warn(
          `JsonApiHrConnector: Skipping row ${i + 1} (missing sourceUserId or email), ` +
            `keys: ${Object.keys(item).join(', ')}`,
        );
      }
    }

    return users;
  }

  async updateUserFields(
    _externalId: string,
    _fields: Record<string, unknown>,
    _config: Record<string, unknown>,
    _tenantId?: string,
  ): Promise<{ success: boolean; updatedFields: string[]; reason?: string }> {
    return { success: false, updatedFields: [], reason: 'read-only' };
  }

  /**
   * Healthy when the endpoint is reachable and accepts the credentials (JsonApiHrClient.probe):
   * the feed itself is not downloaded. Gives up after CONNECTOR_HEALTH_TIMEOUT_MS.
   */
  async healthCheck(config: Record<string, unknown>): Promise<boolean> {
    const { url, method } = config as unknown as JsonApiHrConfig;
    if (!url || typeof url !== 'string') {
      return false;
    }
    try {
      const auth = this.resolveAuth(config as unknown as JsonApiHrConfig);
      return await this.client.probe({ url, method, auth }, CONNECTOR_HEALTH_TIMEOUT_MS);
    } catch {
      return false;
    }
  }

  /**
   * POST /connectors/json-api-hr/health-check: one request to the feed as ingest makes it
   * (JsonApiHrClient.fetch: the SSRF guard, the configured auth, no redirect, the ingest timeout)
   * and the body read as ingest reads it (JSON, responsePath, JSON_HR_MAX_ITEMS), no row mapped.
   * The field map and the auth settings are checked first, with no request. An error names the
   * HTTP status, the network error code or the parse failure, never a credential or the body.
   * The periodic health (healthCheck) stays a probe that does not download the feed. The feed is
   * read with GET only: the connector settings offer no method, and another one would write to
   * the HR system with the stored credentials (400, no request).
   */
  async checkSource(config: Record<string, unknown>): Promise<HrSourceCheck> {
    const { url, method, fieldMap, responsePath } = config as unknown as JsonApiHrConfig;
    if (method != null && method !== '' && String(method).toUpperCase() !== 'GET') {
      throw new BadRequestException(
        `The health check reads the feed with GET only: method "${String(method)}" is refused`,
      );
    }
    if (!url || typeof url !== 'string') return { healthy: false, error: 'url is required' };
    let auth: JsonApiHrAuth | undefined;
    try {
      parseHrFieldMap(fieldMap, 'fieldMap');
      assertSafeResponsePath(responsePath);
      auth = this.resolveAuth(config as unknown as JsonApiHrConfig);
    } catch (error: unknown) {
      return { healthy: false, error: messageOf(error) };
    }

    let data: unknown;
    try {
      data = await this.client.fetch({ url, method: 'GET', auth });
    } catch (error: unknown) {
      return { healthy: false, error: feedFailure(error) };
    }
    // axios hands a body that is not JSON over as text
    if (typeof data === 'string') return { healthy: false, error: 'The response is not JSON' };
    try {
      const count = feedItems(data, responsePath).length;
      const records = count === 1 ? 'record' : 'records';
      return { healthy: true, message: `The endpoint answered with ${count} ${records}` };
    } catch (error: unknown) {
      return { healthy: false, error: messageOf(error) };
    }
  }

  /** Maps the connector config to request credentials; undefined when authType is "none" or unset. */
  private resolveAuth(config: JsonApiHrConfig): JsonApiHrAuth | undefined {
    const authType = config.authType || 'none';
    if (authType === 'none') return undefined;
    if (authType === 'bearer') {
      if (!config.bearerToken) {
        throw new BadRequestException(
          'JsonApiHrConnector: bearerToken is required for authType "bearer"',
        );
      }
      return { type: 'bearer', token: config.bearerToken };
    }
    if (authType === 'header') {
      if (!config.authHeaderName || !config.authHeaderSecret) {
        throw new BadRequestException(
          'JsonApiHrConnector: authHeaderName and authHeaderSecret are required for authType "header"',
        );
      }
      return { type: 'header', name: config.authHeaderName, value: config.authHeaderSecret };
    }
    throw new BadRequestException(
      'JsonApiHrConnector: authType must be "none", "bearer" or "header"',
    );
  }

  private mapItemToUser(
    item: Record<string, unknown>,
    fieldMap: Record<string, string>,
    sourceSystem: string,
    tenantId: string,
  ): Partial<StandardUserDto> | null {
    const mapped: Record<string, string> = {};
    for (const [jsonKey, dtoField] of Object.entries(fieldMap)) {
      const value = item[jsonKey];
      if (value !== undefined && value !== null && value !== '') {
        mapped[dtoField] = String(value).trim();
      }
    }

    const sourceUserId = mapped.sourceUserId ?? mapped.employeeId ?? mapped.email;
    const email = mapped.email;

    if (!sourceUserId || !email) {
      return null;
    }

    const user: Partial<StandardUserDto> = {
      sourceSystem,
      sourceUserId: String(sourceUserId),
      tenantId,
      firstName: mapped.firstName ?? '',
      lastName: mapped.lastName ?? '',
      email: String(email),
      status: UserStatus.ACTIVE,
    };

    if (mapped.jobTitle) user.jobTitle = mapped.jobTitle;
    if (mapped.departmentName) user.departmentName = mapped.departmentName;
    if (mapped.employeeId) user.employeeId = mapped.employeeId;
    if (mapped.employeeNumber) user.employeeNumber = mapped.employeeNumber;
    if (mapped.employmentType) {
      const normalized = mapped.employmentType
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_');
      if (Object.values(EmploymentType).includes(normalized as EmploymentType)) {
        user.employmentType = normalized as EmploymentType;
      }
    }
    if (mapped.mobilePhone) user.mobilePhone = mapped.mobilePhone;
    if (mapped.location) user.location = mapped.location;
    applyHrLifecycleFields(user, mapped, (field) =>
      this.logger.warn(
        `JsonApiHrConnector: Ignoring ${field} that is not a date for ${sourceUserId}`,
      ),
    );
    applyMappedCustomAttributes(user, mapped);

    return user;
  }
}
