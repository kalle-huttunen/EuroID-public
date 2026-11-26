import { Injectable } from '@nestjs/common';
import {
  IEntraConnector,
  ProvisioningIntent,
  Entitlement,
  EntraConfig,
  TargetAccount,
} from './entra.interface';
import type { ConnectorCapability } from '../plugin/connector-manifest.interface';
import type {
  ICredentialManagement,
  CredentialState,
  MfaStatus,
} from '../credential-management.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import {
  ProvisioningOperationResult,
  ProvisioningResult,
} from '@shared/dtos/provisioning-result.dto';
import { EntraDiscoveryService } from './entra-discovery.service';
import { EntraProvisioningService } from './entra-provisioning.service';
import { EntraEntitlementsService } from './entra-entitlements.service';
import { EntraClient } from './entra.client';
import { EntraTenantConfigService } from './entra-tenant-config.service';
import type { ConfigKeyStatus, EntraUserState } from './entra.types';

export type { ConfigKeyStatus } from './entra.types';

/**
 * Facade over the three focused Entra sub-services.
 * All 21+ consumers import EntraService — this thin delegation layer
 * keeps their imports stable while the implementation is split for readability.
 *
 * Every call runs on one config, picked here once and passed to all the Graph calls it makes:
 * the caller's (a canvas config), else the current tenant's installed Entra ID connector config,
 * else the ENTRA_* environment variables (EntraTenantConfigService).
 */
@Injectable()
export class EntraService implements IEntraConnector, ICredentialManagement {
  constructor(
    private readonly discovery: EntraDiscoveryService,
    private readonly provisioning: EntraProvisioningService,
    private readonly entitlements: EntraEntitlementsService,
    private readonly client: EntraClient,
    private readonly tenantConfig: EntraTenantConfigService,
  ) {}

  /** The config a call runs on: `config`, else the tenant's installed one (undefined: ENTRA_*). */
  private configFor(config?: EntraConfig): Promise<EntraConfig | undefined> {
    return this.tenantConfig.resolve(config);
  }

  // --- Discovery (read-only) ---

  /** The ENTRA_* environment variables are set (the deployment's own app registration). */
  isConfigured(): boolean {
    return this.discovery.isConfigured();
  }

  /**
   * Entra ID calls without a config of their own have one to run on: the current tenant has
   * installed the Entra ID connector (complete or not: an incomplete one fails each call with a
   * configuration error), or the ENTRA_* environment variables are set.
   */
  async isConfiguredForTenant(): Promise<boolean> {
    return this.isConfiguredFor();
  }

  /**
   * Which config Entra ID calls without a config of their own run on, by the same pick:
   * the current tenant's installed connector config (complete or not), else the ENTRA_*
   * environment variables, else none (isConfiguredForTenant() is false exactly then).
   */
  async tenantConfigSource(): Promise<'tenant-connector' | 'environment' | 'none'> {
    if ((await this.configFor()) !== undefined) return 'tenant-connector';
    return this.isConfigured() ? 'environment' : 'none';
  }

  /**
   * A call with `config` has an Entra ID config to run on, by the pick every call makes
   * (configFor): `config` itself, any object (an empty or credential-less one included: EntraClient
   * uses it and rejects it as incomplete), else the current tenant's installed connector config
   * (complete or not), else the ENTRA_* environment variables when all three are set. False only
   * when that pick finds nothing, where a call fails with "Missing Entra Config": onboarding then
   * leaves Entra ID out of the run (isEntraConfigured). Reads the tenant from the request context.
   */
  async isConfiguredFor(config?: EntraConfig): Promise<boolean> {
    return (await this.configFor(config)) !== undefined || this.isConfigured();
  }

  getConfigKeysCheck(): Record<string, ConfigKeyStatus> {
    return this.discovery.getConfigKeysCheck();
  }

  async getAvailableLicenses(): Promise<Map<string, number>> {
    return this.discovery.getAvailableLicenses(await this.configFor());
  }

  async isDefaultDomainVerified(
    domainOverride?: string,
  ): Promise<{ ok: boolean; domain: string; verifiedDomains: string[] }> {
    return this.discovery.isDefaultDomainVerified(domainOverride, await this.configFor());
  }

  async checkConnection(config?: EntraConfig): Promise<boolean> {
    return this.discovery.checkConnection(await this.configFor(config));
  }

  async validateCapabilities(config?: EntraConfig): Promise<ConnectorCapability[]> {
    return this.discovery.validateCapabilities(await this.configFor(config));
  }

  async checkUserExists(upn: string, config?: EntraConfig): Promise<string | null> {
    return this.discovery.checkUserExists(upn, await this.configFor(config));
  }

  /** The account with this UPN and its creation time, or null (EntraDiscoveryService). */
  async findAccountByUpn(
    upn: string,
    config?: EntraConfig,
  ): Promise<{ id: string; createdDateTime?: string } | null> {
    return this.discovery.findAccountByUpn(upn, await this.configFor(config));
  }

  async getUserByEmail(email: string, config?: EntraConfig): Promise<TargetAccount | null> {
    return this.discovery.getUserByEmail(email, await this.configFor(config));
  }

  /**
   * The one account with the person's UPN, email (as mail or UPN) or employee id, in that order;
   * null for none, AmbiguousAccountException for an email or employee id two accounts carry
   * (EntraDiscoveryService.findAccountIdByIdentifiers). Read only.
   */
  async findAccountIdByIdentifiers(
    identifiers: { userPrincipalName?: string; email?: string; employeeId?: string },
    config?: EntraConfig,
  ): Promise<string | null> {
    return this.discovery.findAccountIdByIdentifiers(identifiers, await this.configFor(config));
  }

  async listUsers(
    options?: { top?: number; nextLink?: string },
    config?: EntraConfig,
  ): Promise<{ users: TargetAccount[]; nextLink?: string }> {
    return this.discovery.listUsers(options, await this.configFor(config));
  }

  async discoverEntitlements(config?: EntraConfig): Promise<Entitlement[]> {
    return this.discovery.discoverEntitlements(await this.configFor(config));
  }

  // --- Provisioning (user lifecycle) ---

  async resolveAvailableUpn(
    user: StandardUserDto,
    config?: EntraConfig,
  ): Promise<{ chosenUpn: string; candidatesChecked: string[] }> {
    return this.provisioning.resolveAvailableUpn(user, await this.configFor(config));
  }

  async updateUser(userId: string, user: StandardUserDto, config?: EntraConfig): Promise<void> {
    return this.provisioning.updateUser(userId, user, await this.configFor(config));
  }

  /**
   * `accountId`: the identity's written-back object id; `mustExist`: the identity has an account,
   * so none is created (EntraProvisioningService.provision).
   */
  async provision(
    user: StandardUserDto,
    intent?: ProvisioningIntent,
    config?: EntraConfig,
    accountId?: string,
    mustExist = false,
  ): Promise<ProvisioningResult> {
    const cfg = await this.configFor(config);
    return this.provisioning.provision(user, intent, cfg, accountId, mustExist);
  }

  /**
   * Group, directory role and license changes on the account with object id `userId`, nothing
   * else (EntraProvisioningService.changeEntitlements): no attribute written, no account created.
   */
  async changeEntitlements(
    userId: string,
    intent: ProvisioningIntent,
    config?: EntraConfig,
  ): Promise<ProvisioningOperationResult[]> {
    return this.provisioning.changeEntitlements(userId, intent, await this.configFor(config));
  }

  /**
   * The account in the way of creating one for `user` under `upn`, or null
   * (EntraProvisioningService.existingAccountFor). Read only.
   */
  async existingAccountFor(
    user: StandardUserDto,
    upn: string,
    config?: EntraConfig,
  ): Promise<string | null> {
    return this.provisioning.existingAccountFor(user, upn, await this.configFor(config));
  }

  /**
   * Create the account under `upn`, never taking over one: an account in the way fails it with a
   * conflict (EntraProvisioningService.createAccount).
   */
  async createAccount(
    user: StandardUserDto,
    upn: string,
    intent?: ProvisioningIntent,
    config?: EntraConfig,
  ): Promise<ProvisioningResult> {
    const cfg = await this.configFor(config);
    return this.provisioning.createAccount(user, upn, intent, cfg);
  }

  /** Pre-change state of the account provision() would touch, for compensation. */
  async captureUserState(user: StandardUserDto, config?: EntraConfig): Promise<EntraUserState> {
    return this.provisioning.captureUserState(user, await this.configFor(config));
  }

  async restoreUserState(
    objectId: string,
    attributes: Record<string, unknown>,
    config?: EntraConfig,
  ): Promise<void> {
    return this.provisioning.restoreUserState(objectId, attributes, await this.configFor(config));
  }

  // --- Entitlements (groups, roles, licenses, user state) ---

  async resolveGroupId(nameOrId: string): Promise<string | null> {
    return this.entitlements.resolveGroupId(nameOrId, await this.configFor());
  }

  async getUserGroupMemberships(
    userId: string,
  ): Promise<Array<{ id: string; displayName?: string }>> {
    return this.entitlements.getUserGroupMemberships(userId, await this.configFor());
  }

  async getUserGroups(userId: string): Promise<string[]> {
    return this.entitlements.getUserGroups(userId, await this.configFor());
  }

  async syncGroupMemberships(
    userId: string,
    groupOps: ProvisioningIntent['operations'],
  ): Promise<ProvisioningOperationResult[]> {
    return this.entitlements.syncGroupMemberships(userId, groupOps, await this.configFor());
  }

  async addToGroup(objectId: string, groupId: string): Promise<boolean> {
    return this.entitlements.addToGroup(objectId, groupId, await this.configFor());
  }

  async removeFromGroup(objectId: string, groupId: string): Promise<boolean> {
    return this.entitlements.removeFromGroup(objectId, groupId, await this.configFor());
  }

  async listUserMemberships(
    userId: string,
  ): Promise<Array<{ id: string; displayName?: string; odataType?: string }>> {
    return this.entitlements.listUserMemberships(userId, await this.configFor());
  }

  async removeGroupMember(objectId: string, groupId: string): Promise<'removed' | 'not-member'> {
    return this.entitlements.removeGroupMember(objectId, groupId, await this.configFor());
  }

  async syncDirectoryRoles(
    userId: string,
    roleOps: ProvisioningIntent['operations'],
    config?: EntraConfig,
  ): Promise<ProvisioningOperationResult[]> {
    return this.entitlements.syncDirectoryRoles(userId, roleOps, await this.configFor(config));
  }

  async assignDirectoryRole(
    userId: string,
    roleDefinitionId: string,
    config?: EntraConfig,
  ): Promise<string> {
    return this.entitlements.assignDirectoryRole(
      userId,
      roleDefinitionId,
      await this.configFor(config),
    );
  }

  async removeDirectoryRole(assignmentId: string, config?: EntraConfig): Promise<boolean> {
    return this.entitlements.removeDirectoryRole(assignmentId, await this.configFor(config));
  }

  async assignLicense(objectId: string, skuName: string): Promise<boolean> {
    return this.entitlements.assignLicense(objectId, skuName, await this.configFor());
  }

  async disableUser(objectId: string, config?: EntraConfig): Promise<boolean> {
    return this.entitlements.disableUser(objectId, await this.configFor(config));
  }

  async enableUser(objectId: string, config?: EntraConfig): Promise<boolean> {
    return this.entitlements.enableUser(objectId, await this.configFor(config));
  }

  async patchUser(
    objectId: string,
    patch: { accountEnabled?: boolean },
    config?: EntraConfig,
  ): Promise<void> {
    return this.entitlements.patchUser(objectId, patch, await this.configFor(config));
  }

  async deleteUser(upn: string, config?: EntraConfig): Promise<boolean> {
    return this.entitlements.deleteUser(upn, await this.configFor(config));
  }

  // --- Credential state (ICredentialManagement; read only, no password reset) ---

  async getCredentialState(externalId: string): Promise<CredentialState> {
    const raw = await this.client.getCredentialState(externalId, await this.configFor());
    return {
      passwordLastSet: raw.lastPasswordChangeDateTime
        ? new Date(raw.lastPasswordChangeDateTime)
        : undefined,
      accountEnabled: raw.accountEnabled,
    };
  }

  async getMfaStatus(externalId: string): Promise<MfaStatus> {
    const raw = await this.client.getMfaMethods(externalId, await this.configFor());
    const knownMethods: string[] = [];
    for (const m of raw.value ?? []) {
      const t = m['@odata.type'] ?? '';
      if (t.includes('fido2')) knownMethods.push('FIDO2');
      else if (t.includes('microsoftAuthenticator')) knownMethods.push('TOTP');
      else if (t.includes('phone')) knownMethods.push('SMS');
      else if (t.includes('email')) knownMethods.push('EMAIL');
    }
    return { enrolled: knownMethods.length > 0, methods: knownMethods };
  }
}
