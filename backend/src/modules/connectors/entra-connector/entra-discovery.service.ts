import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import type { ConnectorCapability } from '../plugin/connector-manifest.interface';
import { EntraClient } from './entra.client';
import { EntraConfig, Entitlement, TargetAccount } from './entra.interface';
import { ENTRA_SYSTEM } from './entra.constants';
import { everyGraphPage } from './entra-graph-pages';
import type {
  ConfigKeyStatus,
  GraphSku,
  GraphGroup,
  GraphOrganization,
  GraphVerifiedDomain,
  GraphRoleDefinition,
} from './entra.types';

/**
 * More than one Entra ID account carries an identifier of the person (422, not retried): EuroID
 * cannot tell which one is theirs, so it takes neither (findAccountIdByIdentifiers).
 */
export class AmbiguousAccountException extends ConnectorException {
  constructor(identifier: 'email' | 'employee id') {
    super(
      `More than one Entra ID account has the ${identifier} of this identity: link the right ` +
        'account to the identity.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Read-only Entra ID operations: health checks, user lookups, and entitlement discovery.
 */
@Injectable()
export class EntraDiscoveryService {
  private readonly logger = new Logger(EntraDiscoveryService.name);

  constructor(
    private readonly client: EntraClient,
    private readonly config: ConfigService,
  ) {}

  // --- Admin / Diagnostic Methods ---

  isConfigured(): boolean {
    const tenant = this.config.get('ENTRA_TENANT_ID');
    const clientId = this.config.get('ENTRA_CLIENT_ID');
    const secret = this.config.get('ENTRA_CLIENT_SECRET');
    return !!(tenant && clientId && secret);
  }

  getConfigKeysCheck(): Record<string, ConfigKeyStatus> {
    const keys = [
      'ENTRA_TENANT_ID',
      'ENTRA_CLIENT_ID',
      'ENTRA_CLIENT_SECRET',
      'ENTRA_DEFAULT_DOMAIN',
      'ENTRA_DEFAULT_LICENSE',
      'ENTRA_USAGE_LOCATION',
    ];

    const result: Record<string, ConfigKeyStatus> = {};
    for (const key of keys) {
      const val = this.config.get(key);
      if (!val) {
        result[key] = { status: 'missing', hint: `Set ${key} in backend/.env` };
      } else if (val === `<your-${key.toLowerCase().replace(/_/g, '-')}>` || val.startsWith('<')) {
        result[key] = { status: 'placeholder', hint: `Replace the placeholder value for ${key}` };
      } else {
        result[key] = { status: 'ok' };
      }
    }
    return result;
  }

  async getAvailableLicenses(config?: EntraConfig): Promise<Map<string, number>> {
    const skus = await this.client.get<{ value: GraphSku[] }>('/subscribedSkus', config);
    const map = new Map<string, number>();
    for (const sku of skus.value) {
      const available = (sku.prepaidUnits?.enabled ?? 0) - (sku.consumedUnits ?? 0);
      if (sku.skuPartNumber) map.set(sku.skuPartNumber, available);
    }
    return map;
  }

  async isDefaultDomainVerified(
    domainOverride?: string,
    config?: EntraConfig,
  ): Promise<{ ok: boolean; domain: string; verifiedDomains: string[] }> {
    const domain =
      domainOverride ?? (config?.defaultDomain || this.config.get('ENTRA_DEFAULT_DOMAIN')) ?? '';
    const org = await this.client.get<{ value: GraphOrganization[] }>(
      '/organization?$select=verifiedDomains',
      config,
    );
    const verifiedDomains: string[] = (org.value?.[0]?.verifiedDomains || []).map(
      (d: GraphVerifiedDomain) => d.name,
    );
    return {
      ok: domain ? verifiedDomains.includes(domain) : false,
      domain,
      verifiedDomains,
    };
  }

  // --- Core Read Operations ---

  async checkConnection(config?: EntraConfig): Promise<boolean> {
    try {
      await this.client.get('/organization', config);
      return true;
    } catch {
      return false;
    }
  }

  async validateCapabilities(config?: EntraConfig): Promise<ConnectorCapability[]> {
    const staticCaps: ConnectorCapability[] = [
      'discover',
      'provision',
      'deprovision',
      'healthCheck',
      'reconciliation',
    ];
    try {
      const caps: ConnectorCapability[] = ['healthCheck'];
      try {
        await this.client.get<{ value?: unknown[] }>('/users?$top=1&$select=id', config);
        caps.push('discover', 'reconciliation');
      } catch {
        return staticCaps;
      }
      if (staticCaps.includes('provision')) caps.push('provision');
      if (staticCaps.includes('deprovision')) caps.push('deprovision');
      return caps;
    } catch {
      return staticCaps;
    }
  }

  async checkUserExists(upn: string, config?: EntraConfig): Promise<string | null> {
    try {
      const res = await this.client.get<{ id: string }>(
        `/users/${encodeURIComponent(upn)}?$select=id`,
        config,
      );
      return res.id;
    } catch (e: unknown) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }

  /**
   * The account with this UPN and when Entra ID created it (`createdDateTime`, absent when Graph
   * does not say); null when there is none.
   */
  async findAccountByUpn(
    upn: string,
    config?: EntraConfig,
  ): Promise<{ id: string; createdDateTime?: string } | null> {
    try {
      const res = await this.client.get<{ id: string; createdDateTime?: string }>(
        `/users/${encodeURIComponent(upn)}?$select=id,createdDateTime`,
        config,
      );
      return { id: res.id, createdDateTime: res.createdDateTime };
    } catch (e: unknown) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }

  async getUserByEmail(email: string, config?: EntraConfig): Promise<TargetAccount | null> {
    const escaped = email.replace(/'/g, "''");
    const filter = `mail eq '${escaped}' or userPrincipalName eq '${escaped}'`;
    const select = 'id,userPrincipalName,mail,displayName,accountEnabled';
    try {
      const res = await this.client.get<{
        value?: Array<{
          id: string;
          userPrincipalName?: string;
          mail?: string;
          displayName?: string;
          accountEnabled?: boolean;
        }>;
      }>(`/users?$filter=${encodeURIComponent(filter)}&$top=1&$select=${select}`, config);
      const u = res.value?.[0];
      if (!u) return null;
      return {
        id: u.id,
        userPrincipalName: u.userPrincipalName ?? '',
        mail: u.mail,
        displayName: u.displayName,
        accountEnabled: u.accountEnabled,
      };
    } catch (e: unknown) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }

  /**
   * The account of a person EuroID provisioned, by the identifiers provisioning used, in this
   * order: the UPN, the email as mail or UPN, the employee id (written to the account on create
   * and on every update). Null when no account has them. An email or employee id that more than
   * one account carries fails (AmbiguousAccountException, 422): EuroID cannot tell which one is
   * the person's. A UPN names one account at most.
   */
  async findAccountIdByIdentifiers(
    identifiers: { userPrincipalName?: string; email?: string; employeeId?: string },
    config?: EntraConfig,
  ): Promise<string | null> {
    const upn = identifiers.userPrincipalName?.trim();
    const byUpn = upn ? await this.checkUserExists(upn, config) : null;
    if (byUpn) return byUpn;
    const email = identifiers.email?.trim();
    if (email) {
      const escaped = email.replace(/'/g, "''");
      const filter = `mail eq '${escaped}' or userPrincipalName eq '${escaped}'`;
      const byEmail = await this.onlyAccountId(filter, 'email', config);
      if (byEmail) return byEmail;
    }
    const employeeId = identifiers.employeeId?.trim();
    if (!employeeId) return null;
    const filter = `employeeId eq '${employeeId.replace(/'/g, "''")}'`;
    return this.onlyAccountId(filter, 'employee id', config);
  }

  /** The id of the one account `filter` matches; null for none, and two fail (ambiguous). */
  private async onlyAccountId(
    filter: string,
    identifier: 'email' | 'employee id',
    config?: EntraConfig,
  ): Promise<string | null> {
    let accounts: Array<{ id: string }>;
    try {
      const res = await this.client.get<{ value?: Array<{ id: string }> }>(
        `/users?$filter=${encodeURIComponent(filter)}&$top=2&$select=id`,
        config,
      );
      accounts = res.value ?? [];
    } catch (e: unknown) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
    if (accounts.length > 1) throw new AmbiguousAccountException(identifier);
    return accounts[0]?.id ?? null;
  }

  async listUsers(
    options?: { top?: number; nextLink?: string },
    config?: EntraConfig,
  ): Promise<{ users: TargetAccount[]; nextLink?: string }> {
    const mapResponse = (res: {
      value?: Array<{
        id: string;
        userPrincipalName?: string;
        mail?: string;
        displayName?: string;
        accountEnabled?: boolean;
      }>;
    }): TargetAccount[] =>
      (res.value ?? []).map((u) => ({
        id: u.id,
        userPrincipalName: u.userPrincipalName ?? '',
        mail: u.mail,
        displayName: u.displayName,
        accountEnabled: u.accountEnabled,
      }));

    if (options?.nextLink) {
      const res = await this.client.getByUrl<{
        value?: Array<{
          id: string;
          userPrincipalName?: string;
          mail?: string;
          displayName?: string;
          accountEnabled?: boolean;
        }>;
        '@odata.nextLink'?: string;
      }>(options.nextLink, config);
      return { users: mapResponse(res), nextLink: res['@odata.nextLink'] };
    }

    const top = Math.min(options?.top ?? 999, 999);
    const select = 'id,userPrincipalName,mail,displayName,accountEnabled';
    const res = await this.client.get<{
      value?: Array<{
        id: string;
        userPrincipalName?: string;
        mail?: string;
        displayName?: string;
        accountEnabled?: boolean;
      }>;
      '@odata.nextLink'?: string;
    }>(`/users?$top=${top}&$select=${select}`, config);

    return { users: mapResponse(res), nextLink: res['@odata.nextLink'] };
  }

  // --- Entitlement Discovery ---

  private async discoverDirectoryRoles(config?: EntraConfig): Promise<Entitlement[]> {
    const res = await this.client.get<{ value: GraphRoleDefinition[] }>(
      '/roleManagement/directory/roleDefinitions',
      config,
    );
    const roles = (res.value ?? []).filter((r) => r.isBuiltIn === true && (r.templateId ?? r.id));
    return roles.map((role) => {
      const templateId = role.templateId ?? role.id ?? '';
      return {
        nativeId: templateId,
        name: role.displayName ?? templateId,
        type: 'DirectoryRole' as const,
        system: ENTRA_SYSTEM,
        origin: 'EXTERNAL' as const,
        governanceLevel: 'STRICT' as const,
        metadata: { description: role.description, isBuiltIn: role.isBuiltIn, templateId },
      };
    });
  }

  async discoverEntitlements(config?: EntraConfig): Promise<Entitlement[]> {
    const [groups, skus, roleEntitlements] = await Promise.all([
      everyGraphPage<GraphGroup>(this.client, '/groups?$select=id,displayName', config),
      this.client.get<{ value: GraphSku[] }>('/subscribedSkus', config),
      this.discoverDirectoryRoles(config).catch((e) => {
        this.logger.warn(
          `[DISCOVER] Directory roles unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        return [];
      }),
    ]);

    const groupEntitlements = groups.map((g) => ({
      nativeId: g.id,
      name: g.displayName ?? g.id,
      type: 'Group' as const,
      system: ENTRA_SYSTEM,
      origin: 'EXTERNAL' as const,
      governanceLevel: 'OPEN' as const,
    }));

    const licenseEntitlements = skus.value
      .filter((s): s is GraphSku & { skuPartNumber: string } => !!s.skuPartNumber)
      .map((s) => ({
        nativeId: s.skuPartNumber,
        name: s.skuPartNumber,
        type: 'License' as const,
        system: ENTRA_SYSTEM,
        origin: 'EXTERNAL' as const,
        governanceLevel: 'OPEN' as const,
        // The license forecast starts from these (catalog licenseUnits)
        ...(typeof s.consumedUnits === 'number' && typeof s.prepaidUnits?.enabled === 'number'
          ? { licenseUnits: { consumed: s.consumedUnits, enabled: s.prepaidUnits.enabled } }
          : {}),
      }));

    const all = [...groupEntitlements, ...licenseEntitlements, ...roleEntitlements];
    this.logger.log(
      `[DISCOVER] Found ${groupEntitlements.length} groups, ${licenseEntitlements.length} licenses, ${roleEntitlements.length} directory roles`,
    );
    return all;
  }
}
