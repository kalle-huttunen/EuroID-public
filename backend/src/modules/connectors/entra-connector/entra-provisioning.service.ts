import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { ConfigService } from '@nestjs/config';
import { EntraClient } from './entra.client';
import { EntraMapper } from './entra.mapper';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import {
  ProvisioningOperationResult,
  ProvisioningResult,
} from '@shared/dtos/provisioning-result.dto';
import { EntraConfig, ProvisioningIntent, DEFAULT_UPN_PATTERNS } from './entra.interface';
import { generateUpnCandidates } from './upn-generator';
import { UpnExhaustedError, InvalidDomainError } from './upn.errors';
import { EntraDiscoveryService } from './entra-discovery.service';
import { EntraEntitlementsService } from './entra-entitlements.service';
import { failedChange, type EntraOperation } from './entra-change-result';
import { CredentialGenerationService } from '@infrastructure/secrets/credential-generation.service';
import { maskEmails } from '../../../activities/deprovision-failure';
import type { GraphUserResponse, EntraUserState } from './entra.types';
import { isLinkedAdminProfile } from '@shared/utils/linked-admin-profile';

/**
 * Entra ID user lifecycle: provisioning, attribute updates, and UPN resolution.
 */
@Injectable()
export class EntraProvisioningService {
  private readonly logger = new Logger(EntraProvisioningService.name);

  constructor(
    private readonly client: EntraClient,
    private readonly mapper: EntraMapper,
    private readonly config: ConfigService,
    private readonly discovery: EntraDiscoveryService,
    private readonly entitlements: EntraEntitlementsService,
    private readonly credentialGeneration: CredentialGenerationService,
  ) {}

  // --- UPN Resolution ---

  async resolveAvailableUpn(
    user: StandardUserDto,
    config?: EntraConfig,
  ): Promise<{ chosenUpn: string; candidatesChecked: string[] }> {
    const domain = config?.defaultDomain || this.config.get('ENTRA_DEFAULT_DOMAIN') || '';
    if (!domain) {
      throw new ConnectorException(
        'Cannot resolve UPN: ENTRA_DEFAULT_DOMAIN or config.defaultDomain is required',
      );
    }
    if (!user.firstName?.trim() || !user.lastName?.trim()) {
      throw new ConnectorException('Cannot generate UPN: firstName and lastName are required');
    }

    const domainCheck = await this.discovery.isDefaultDomainVerified(domain, config);
    if (!domainCheck.ok) {
      throw new InvalidDomainError(
        `Domain "${domain}" is not verified in M365. Configure ENTRA_DEFAULT_DOMAIN.`,
        domain,
        domainCheck.verifiedDomains,
      );
    }

    if (isLinkedAdminProfile(user)) return this.resolveAdminUpn(user, domain, config);

    const patterns = config?.upnPatterns || DEFAULT_UPN_PATTERNS;
    const preferredUpn = user.userPrincipalName || user.email;
    const candidates = generateUpnCandidates(user, domain, patterns, 10, preferredUpn);

    if (candidates.length === 0) {
      throw new ConnectorException(
        'Cannot generate UPN: no candidates produced. Check firstName/lastName.',
      );
    }

    const candidatesChecked: string[] = [];
    for (const candidate of candidates) {
      candidatesChecked.push(candidate);
      const exists = await this.discovery.checkUserExists(candidate, config);
      if (!exists) {
        this.logger.log(
          `[UPN] Resolved available UPN: ${maskEmails(candidate)} (checked ${candidatesChecked.length} candidates)`,
        );
        return { chosenUpn: candidate, candidatesChecked };
      }
    }

    throw new UpnExhaustedError(
      `All ${candidatesChecked.length} UPN candidates are taken. Manual assignment required.`,
      candidatesChecked,
      candidatesChecked[candidatesChecked.length - 1],
    );
  }

  /**
   * A linked admin account (PAM) is created under the UPN admin-upn.ts gave it, or not at all: a
   * firstname.lastname fallback would make it look like the person's daily account. Its UPN
   * outside the default domain, or held by another account, fails (422, not retried). The
   * messages name no address: they reach workflow history in clear.
   */
  private async resolveAdminUpn(
    user: StandardUserDto,
    domain: string,
    config?: EntraConfig,
  ): Promise<{ chosenUpn: string; candidatesChecked: string[] }> {
    const upn = (user.userPrincipalName || user.email || '').trim().toLowerCase();
    const cleanDomain = domain.replace(/^@/, '').trim().toLowerCase();
    if (!upn.endsWith(`@${cleanDomain}`)) {
      throw new ConnectorException(
        `The admin account's UPN is not in the Entra ID default domain (${cleanDomain}): set ` +
          'ADMIN_UPN_PATTERN to an address in that domain',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (await this.discovery.checkUserExists(upn, config)) {
      throw new ConnectorException(
        "The admin account's UPN is taken in Entra ID by another account: free it there, or " +
          'change ADMIN_UPN_PATTERN',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return { chosenUpn: upn, candidatesChecked: [upn] };
  }

  // --- User Attribute Updates ---

  async updateUser(userId: string, user: StandardUserDto, config?: EntraConfig): Promise<void> {
    this.logger.debug(`[UPDATE] Starting update for user ${userId}`);

    const updatePayload = this.mapper.toEntraUpdatePayload(user);

    if (Object.keys(updatePayload).length > 0) {
      this.logger.log('[UPDATE] Updating Entra User', {
        id: maskEmails(String(user.sourceUserId ?? '')),
        fields: Object.keys(updatePayload),
      });
      await this.client.patch(`/users/${userId}`, updatePayload, config);
      this.logger.log(`[UPDATE] Successfully updated user ${userId} in Entra ID`);
    } else {
      this.logger.log(`[UPDATE] No updatable fields found for user ${userId}, skipping PATCH call`);
    }
  }

  // --- Compensation (rollback of a bulk CREATE or UPDATE) ---

  /**
   * The account provision() would update for this user, with the current values of the
   * attributes that update would write; `existed: false` when provision() would create one.
   */
  async captureUserState(user: StandardUserDto, config?: EntraConfig): Promise<EntraUserState> {
    const userId = await this.findExistingUserId(user, config);
    if (!userId) return { existed: false };
    const fields = Object.keys(this.mapper.toEntraUpdatePayload(user));
    if (fields.length === 0) return { existed: true, objectId: userId, attributes: {} };
    const current = await this.client.get<Record<string, unknown>>(
      `/users/${encodeURIComponent(userId)}?$select=${fields.join(',')}`,
      config,
    );
    const attributes: Record<string, unknown> = {};
    for (const field of fields) attributes[field] = current?.[field] ?? null;
    return { existed: true, objectId: userId, attributes };
  }

  /** Write captured attribute values back (null clears an attribute that was unset). */
  async restoreUserState(
    objectId: string,
    attributes: Record<string, unknown>,
    config?: EntraConfig,
  ): Promise<void> {
    if (Object.keys(attributes).length === 0) return;
    await this.client.patch(`/users/${encodeURIComponent(objectId)}`, attributes, config);
  }

  /** Same lookup as provision(): by UPN (or email) only when it is in the default domain. */
  private async findExistingUserId(
    user: StandardUserDto,
    config?: EntraConfig,
  ): Promise<string | null> {
    const domain = config?.defaultDomain || this.config.get('ENTRA_DEFAULT_DOMAIN') || '';
    const existingUpn = user.userPrincipalName || user.email;
    const hasValidDomainUpn = domain && existingUpn?.includes(`@${domain.replace(/^@/, '')}`);
    return hasValidDomainUpn ? this.discovery.checkUserExists(existingUpn, config) : null;
  }

  /**
   * The id of the account with the recorded object id; none such fails (422, not retried): the
   * identity has an account, so a missing one is for an admin to check, never created again.
   */
  private async recordedAccountId(accountId: string, config?: EntraConfig): Promise<string> {
    const userId = await this.discovery.checkUserExists(accountId, config);
    if (userId) return userId;
    throw new ConnectorException(
      `No Entra ID account has the object id recorded for the identity (${accountId}): it may ` +
        'have been deleted in Entra ID. EuroID does not create a second account for an identity ' +
        'that has one. Check the account in Entra ID.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  /**
   * The account of an identity that has one but no recorded object id (bulk provisioning writes
   * none back), by the identifiers the profile holds: its UPN, its email as mail or UPN, its
   * employee id. None found fails (422, not retried): a second account is never created for it.
   */
  private async existingAccountId(user: StandardUserDto, config?: EntraConfig): Promise<string> {
    const userId = await this.discovery.findAccountIdByIdentifiers(
      { userPrincipalName: user.userPrincipalName, email: user.email, employeeId: user.employeeId },
      config,
    );
    if (userId) return userId;
    throw new ConnectorException(
      'The Entra ID account of this identity was not found: no object id is recorded for it, ' +
        'and no account has its UPN, email or employee id. Link the account to the identity or ' +
        're-provision it; EuroID does not create a second account for an identity that has one.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  // --- Main Provisioning ---

  /**
   * Create or update the user's account, then run the intent. `accountId`: the object id
   * written back for the identity; the account is found by it alone. Without one, by UPN (or
   * email) in the default domain; no match creates the account. `mustExist` (the identity's
   * provisioning entry says it has an account): without an object id the account is found by
   * the identifiers the profile holds, and none found fails instead of creating one.
   */
  async provision(
    user: StandardUserDto,
    intent?: ProvisioningIntent,
    config?: EntraConfig,
    accountId?: string,
    mustExist = false,
  ): Promise<ProvisioningResult> {
    // 1. Idempotency Check
    let userId = accountId
      ? await this.recordedAccountId(accountId, config)
      : mustExist
        ? await this.existingAccountId(user, config)
        : await this.findExistingUserId(user, config);

    // 2. Create if missing, or UPDATE if exists
    let generatedAttributes: ProvisioningResult['generatedAttributes'] | undefined;
    let upnResolution: ProvisioningResult['upnResolution'] | undefined;

    if (!userId) {
      const { chosenUpn, candidatesChecked } = await this.resolveAvailableUpn(user, config);
      upnResolution = { chosenUpn, candidatesChecked };
      ({ userId, generatedAttributes } = await this.createUser(user, chosenUpn, config));
    } else {
      this.logger.log(
        `User ${maskEmails(user.email)} already exists (${userId}) - UPDATING ATTRIBUTES`,
      );
      await this.updateUser(userId, user, config);
      this.logger.log(`Update complete for ${maskEmails(user.email)}`);
    }

    // 3. Execute Intent: each change reported, none thrown (the account stays created/updated)
    let operations: ProvisioningOperationResult[] | undefined;
    if (intent) {
      const opCount = intent.operations?.length || 0;
      this.logger.log(
        `[PROVISION] Intent received with ${opCount} operations — running group/license sync`,
      );
      operations = await this.executeIntent(userId, intent, config);
    } else {
      this.logger.log(`[PROVISION] No intent provided, skipping group/license sync`);
    }

    return {
      targetUserId: userId,
      generatedAttributes,
      upnResolution,
      ...(operations ? { operations } : {}),
    };
  }

  // --- Create only (a distributed-transaction CREATE) ---

  /**
   * The id of an account in the way of creating one for this user under `upn`: an account with
   * that UPN or the user's own UPN, the user's email as mail or UPN, or the user's employee id;
   * null when there is none. An email or employee id two accounts carry throws
   * (AmbiguousAccountException): those accounts are in the way too. Read only.
   */
  async existingAccountFor(
    user: StandardUserDto,
    upn: string,
    config?: EntraConfig,
  ): Promise<string | null> {
    const upns = new Set([upn, user.userPrincipalName].filter((u): u is string => !!u?.trim()));
    for (const candidate of upns) {
      const id = await this.discovery.checkUserExists(candidate, config);
      if (id) return id;
    }
    return this.discovery.findAccountIdByIdentifiers(
      { email: user.email, employeeId: user.employeeId },
      config,
    );
  }

  /**
   * Create the user's account under `upn` (the UPN a distributed transaction's prepare resolved),
   * then run the intent as provision() does. Unlike provision() it never takes over an account:
   * when one is in the way (existingAccountFor) it fails with a conflict (409) and creates and
   * changes nothing, so the account it reports is always one it created.
   */
  async createAccount(
    user: StandardUserDto,
    upn: string,
    intent?: ProvisioningIntent,
    config?: EntraConfig,
  ): Promise<ProvisioningResult> {
    if (await this.existingAccountFor(user, upn, config)) {
      throw new ConnectorException(
        'An Entra ID account already has the UPN, email or employee id of this user: no account ' +
          'is created, and the existing one is left as it is',
        HttpStatus.CONFLICT,
      );
    }
    const { userId, generatedAttributes } = await this.createUser(user, upn, config);
    const operations = intent ? await this.executeIntent(userId, intent, config) : undefined;
    return {
      targetUserId: userId,
      generatedAttributes,
      upnResolution: { chosenUpn: upn, candidatesChecked: [upn] },
      ...(operations ? { operations } : {}),
    };
  }

  /** POST the new account under `upn`, with a generated password. */
  private async createUser(
    user: StandardUserDto,
    upn: string,
    config?: EntraConfig,
  ): Promise<{ userId: string; generatedAttributes?: ProvisioningResult['generatedAttributes'] }> {
    const usageLoc = config?.usageLocation || this.config.get('ENTRA_USAGE_LOCATION') || 'US';
    const password = this.credentialGeneration.generatePassword();
    const entraUser = this.mapper.toEntraProfile(user, usageLoc, upn, password);

    this.logger.log(`Creating new user ${maskEmails(entraUser.userPrincipalName)}`);
    const created = await this.client.post<GraphUserResponse>(
      '/users',
      entraUser as unknown as Record<string, unknown>,
      config,
    );
    this.logger.log(`Created user with ID: ${created.id}`);
    const generatedAttributes =
      created.mail || created.userPrincipalName
        ? { mail: created.mail, userPrincipalName: created.userPrincipalName }
        : undefined;
    return { userId: created.id, generatedAttributes };
  }

  /**
   * The intent's group, directory role and license changes on the account `userId` (an object id
   * the caller read), and nothing else: no attribute is written and no account is looked up or
   * created. Each change reported as in provision() (executeIntent).
   */
  changeEntitlements(
    userId: string,
    intent: ProvisioningIntent,
    config?: EntraConfig,
  ): Promise<ProvisioningOperationResult[]> {
    return this.executeIntent(userId, intent, config);
  }

  /**
   * Run the intent's operations and report each, in the order they run: groups, directory roles,
   * licenses (EntraEntitlementsService). An operation of another type or action is not run and
   * is reported failed. No single change throws: what a failed one means is the caller's call.
   */
  private async executeIntent(
    userId: string,
    intent: ProvisioningIntent,
    config?: EntraConfig,
  ): Promise<ProvisioningOperationResult[]> {
    const ops = intent.operations ?? [];
    this.logger.log(`[PROVISION] Executing ${ops.length} operations for user ${userId}`);

    const supported = ops.filter(isSupported);
    const ofType = (type: EntraOperation['type']) => supported.filter((op) => op.type === type);
    const groupOps = ofType('group');
    const roleOps = ofType('role');
    const licenseOps = ofType('license');
    return [
      ...(groupOps.length > 0
        ? await this.entitlements.syncGroupMemberships(userId, groupOps, config)
        : []),
      ...(roleOps.length > 0
        ? await this.entitlements.syncDirectoryRoles(userId, roleOps, config)
        : []),
      ...(licenseOps.length > 0
        ? await this.entitlements.syncLicenses(userId, licenseOps, config)
        : []),
      ...ops
        .filter((op) => !isSupported(op))
        .map((op) =>
          failedChange(
            op,
            new ConnectorException(
              `Entra ID has no "${op.type}" operation with action "${op.action}"`,
            ),
          ),
        ),
    ];
  }
}

/** A group, directory role or license operation that adds or removes. */
function isSupported(op: EntraOperation): boolean {
  return (
    (op.type === 'group' || op.type === 'role' || op.type === 'license') &&
    (op.action === 'add' || op.action === 'remove')
  );
}
