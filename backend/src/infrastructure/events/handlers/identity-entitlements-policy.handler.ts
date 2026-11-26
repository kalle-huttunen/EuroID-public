import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type {
  IdentityEntitlementGrant,
  IdentityEntitlementsQueryPayload,
  IdentityEntitlementsQueryResult,
} from '../event-payloads';
import { IdentityService } from '../../../modules/identity/identity.service';
import {
  PolicyEngineService,
  type ProvisioningOperation,
} from '../../../modules/policy/policy-engine.service';
import type { IdentityDocument } from '../../../modules/identity/schemas/identity.schema';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';

/** Operation types that grant access in a target system (others set attributes, MFA, etc.). */
const ENTITLEMENT_OPERATION_TYPES: ReadonlySet<ProvisioningOperation['type']> = new Set([
  'group',
  'license',
  'role',
]);

/**
 * Handles IDENTITY_ENTITLEMENTS_QUERY (from GET /identity/:id/entitlements).
 * Evaluates the active policies against the identity's golden record (same profile the
 * onboarding workflow evaluates) and returns the group/license/role grants they produce.
 * Read-only: uses the SoD-free evaluation, which emits no events.
 */
@Injectable()
export class IdentityEntitlementsPolicyHandler {
  constructor(
    private readonly identityService: IdentityService,
    private readonly policyEngine: PolicyEngineService,
  ) {}

  // No `async: true`: EventEmitter2 would then return a setImmediate handle instead of this
  // result to emitAndWait. suppressErrors: false lets a failure reach the HTTP caller.
  @OnEvent(DomainEventType.IDENTITY_ENTITLEMENTS_QUERY, { suppressErrors: false })
  async handleEntitlementsQuery(
    event: DomainEvent<IdentityEntitlementsQueryPayload>,
  ): Promise<IdentityEntitlementsQueryResult> {
    const identity = await this.identityService.findIdentityById(event.payload.identityId);
    if (!identity) return { kind: 'identity-entitlements', grants: [] };

    // The builder accepts a hydrated document or a plain object (it calls toObject() itself
    // when there is one); this handler passes the plain object.
    const profile = (await this.identityService.buildProfileWithContractsForPolicy(
      identity.toObject() as unknown as IdentityDocument,
    )) as unknown as StandardUserDto;
    const operations = await this.policyEngine.evaluateOperationsWithoutSod(
      profile,
      event.metadata.tenantId || undefined,
    );

    const grants: IdentityEntitlementGrant[] = operations
      .filter((op) => op.action === 'add' && ENTITLEMENT_OPERATION_TYPES.has(op.type))
      .map((op) => ({
        grantedBy: 'policy',
        entitlement: op.targetId,
        type: op.type,
        targetSystem: op.target,
        source: op.sourcePolicy,
      }));
    return { kind: 'identity-entitlements', grants };
  }
}
