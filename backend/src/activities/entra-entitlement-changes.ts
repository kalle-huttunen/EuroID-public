/**
 * Entitlement-only changes on an identity's recorded Entra ID account: group memberships,
 * directory roles and licenses, and nothing else. Access request fulfilment and expiry use it
 * (AccessRequestActivities): a request grants or removes an entitlement, it does not own the
 * person's attributes (the mover and an edit's sync write those from the full Golden Record) and
 * it never creates an account (onboarding does). provisionUserToEntra, which those paths used
 * before, PATCHed the attributes of the profile it was given and created the account when no
 * object id was recorded.
 *
 * The account is the object id written back for the identity (liveTargetAccountId). Without
 * one (bulk provisioning recorded none before HX-E3), and only when the identity's Entra ID entry
 * says an account was provisioned, the account is looked up read-only by the profile's UPN, email
 * and employee id; the one match is recorded for the identity (its target source only, no profile
 * write) and changed (foundAccountId). What the change came to:
 * - `changed`: every change made or already as requested (provisioning.completed emitted);
 * - `no-account`: no object id recorded and no single recordable account found by the
 *   identifiers (`recorded: false`), or Entra ID no longer knows the recorded one
 *   (`recorded: true`); nothing was asked of Graph beyond those lookups;
 * - `refused`: Graph refused a change, or the call, in a way retrying cannot fix (a 4xx other
 *   than 408, 409 and 429, refused credentials, a missing config; offboarding's rule,
 *   deprovision-failure.ts). The reason names each failed change, emails masked.
 * A failure retrying can fix (a 5xx, no answer, a 429) is thrown for the caller to retry; the
 * changes are idempotent, so a retry makes only what is left.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { isValidObjectId } from 'mongoose';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { ENTRA_SYSTEM } from '../modules/connectors/entra-connector/entra.constants';
import { AmbiguousAccountException } from '../modules/connectors/entra-connector/entra-discovery.service';
import { getSystemType } from '@shared/utils/normalize-system-name';
import { IdentityService } from '../modules/identity/identity.service';
import {
  liveTargetAccountId,
  provisionedSystems,
} from '../modules/identity/identity-provisioning.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { ProvisioningIntent } from '@shared/interfaces/provisioning.interface';
import type { ProvisioningOperationResult } from '@shared/dtos/provisioning-result.dto';
import { ENTRA_CHANGES_FAILED } from '@shared/types/entra-provisioning';
import { asDeprovisionFailure } from './deprovision-failure';
import { changesFailedMessage, changesFailure } from './target-changes-failure';

export type EntitlementChangeOutcome =
  | { status: 'changed'; operations: ProvisioningOperationResult[] }
  | { status: 'no-account'; recorded: boolean }
  | { status: 'refused'; reason: string };

const isFinal = (failure: unknown) => failure instanceof ApplicationFailure && failure.nonRetryable;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

@Injectable()
export class EntraEntitlementChanges {
  private readonly logger = new Logger(EntraEntitlementChanges.name);

  constructor(
    private readonly entraService: EntraService,
    private readonly identityService: IdentityService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The operations on the identity's recorded Entra ID account (see the file comment). */
  async change(
    identityId: string,
    operations: ProvisioningIntent['operations'],
  ): Promise<EntitlementChangeOutcome> {
    const identity = isValidObjectId(identityId)
      ? await this.identityService.findIdentityById(identityId)
      : null;
    if (!identity) return { status: 'no-account', recorded: false };
    const recordedId = liveTargetAccountId(identity, ENTRA_SYSTEM);

    const startTime = Date.now();
    let accountId: string | null;
    let results: ProvisioningOperationResult[];
    try {
      if (recordedId) {
        accountId = await this.entraService.checkUserExists(recordedId);
        if (!accountId) return { status: 'no-account', recorded: true };
      } else {
        accountId = await this.foundAccountId(identityId, identity);
        if (!accountId) return { status: 'no-account', recorded: false };
      }
      results = await this.entraService.changeEntitlements(accountId, { operations });
    } catch (e: unknown) {
      const failure = asDeprovisionFailure(ENTRA_SYSTEM, e);
      if (isFinal(failure)) return { status: 'refused', reason: messageOf(failure) };
      throw failure;
    }

    const failed = results.filter((op) => op.outcome === 'failed');
    if (failed.length > 0) {
      const message = changesFailedMessage(ENTRA_SYSTEM, results.length, failed);
      const failure = changesFailure(ENTRA_SYSTEM, message, failed, ENTRA_CHANGES_FAILED);
      if (isFinal(failure)) return { status: 'refused', reason: message };
      throw failure;
    }

    this.eventEmitter.emit(DomainEventType.PROVISIONING_COMPLETED, identityId, {
      identityId,
      connector: ENTRA_SYSTEM,
      targetUserId: accountId,
      operations: results.map((op) => ({
        action: op.action,
        type: op.type,
        targetId: op.targetId,
        success: true,
      })),
      durationMs: Date.now() - startTime,
    });
    return { status: 'changed', operations: results };
  }

  /**
   * The account of an identity with no recorded object id (bulk provisioning recorded none before
   * HX-E3) whose Entra ID provisioning entry says an account was provisioned (provisionedSystems:
   * not a deprovisioned entry, not one that never synced; bulk creates write the entry, and
   * migration 20261126000007 backfills it): looked up read-only by the profile's
   * UPN, email (as mail or UPN) and employee id, the identifiers provisioning writes
   * (findAccountIdByIdentifiers, as the mover's mustExist lookup). Taken only when it is the one
   * match and the identity can record it (recordTargetAccountId: no other identity has it, no
   * other id is recorded); it is recorded before any change, so the next change finds it by its
   * id. Null keeps the refusal: no Entra ID account provisioned for the identity (an identifier
   * match could be someone else's account: a guest, a shared mailbox), no match, several, or none
   * recordable.
   */
  private async foundAccountId(
    identityId: string,
    identity: NonNullable<Awaited<ReturnType<IdentityService['findIdentityById']>>>,
  ): Promise<string | null> {
    const provisioned = provisionedSystems(identity).some(
      (system) => getSystemType(system) === 'entra',
    );
    const profile = (identity.profile ?? {}) as {
      userPrincipalName?: string;
      email?: string;
      employeeId?: string;
    };
    const identifiers = {
      userPrincipalName: profile.userPrincipalName,
      email: profile.email,
      employeeId: profile.employeeId,
    };
    if (!provisioned || !Object.values(identifiers).some((v) => v?.trim())) return null;

    let found: string | null;
    try {
      found = await this.entraService.findAccountIdByIdentifiers(identifiers);
    } catch (e: unknown) {
      if (e instanceof AmbiguousAccountException) {
        this.logger.warn(`[EntitlementChanges] ${identityId}: ${e.message}`);
        return null;
      }
      throw e;
    }
    if (!found) return null;
    const outcome = await this.identityService.recordTargetAccountId(
      identityId,
      ENTRA_SYSTEM,
      found,
    );
    this.logger.log(
      `[EntitlementChanges] ${identityId}: Entra ID account ${found} found by its identifiers ` +
        `(no object id was recorded): ${outcome}`,
    );
    return outcome === 'recorded' || outcome === 'already' ? found : null;
  }

  /**
   * provisioning.failed for a refusal a person must act on: it reaches the audit log, the
   * console's notifications and webhook subscribers. `reason` is a `refused` outcome's (masked).
   * `accessRequestId`: the access request whose fulfilment or removal was refused, so a
   * subscriber can link to it (its page offers closing a failing removal by hand).
   */
  reportRefused(identityId: string, reason: string, accessRequestId?: string): void {
    this.eventEmitter.emit(DomainEventType.PROVISIONING_FAILED, identityId, {
      ...(isValidObjectId(identityId) ? { identityId } : {}),
      ...(accessRequestId ? { accessRequestId } : {}),
      connector: ENTRA_SYSTEM,
      error: reason,
      retryable: false,
    });
  }
}
