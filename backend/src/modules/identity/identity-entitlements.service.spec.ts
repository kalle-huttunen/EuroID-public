import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type {
  IdentityEntitlementGrant,
  IdentityEntitlementsQueryResult,
} from '@infrastructure/events/event-payloads';
import { connectTestDb, clearTestDb, closeTestDb, createMockEventEmitter } from '@testing';
import { IdentitySchema, IdentityDocument, ProvisioningState } from './schemas/identity.schema';
import { IdentityEntitlementsService } from './identity-entitlements.service';

// Register tenant scoping plugin (normally done by TenantModule at import time)
mongoose.plugin(tenantPlugin);

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function policyGrant(overrides: Partial<IdentityEntitlementGrant> = {}): IdentityEntitlementGrant {
  return {
    grantedBy: 'policy',
    entitlement: 'SG-Engineering',
    type: 'group',
    targetSystem: 'entra-id',
    source: 'Engineering birthright',
    ...overrides,
  };
}

function handlerResult(grants: IdentityEntitlementGrant[]): IdentityEntitlementsQueryResult {
  return { kind: 'identity-entitlements', grants };
}

describe('IdentityEntitlementsService', () => {
  let identityModel: Model<IdentityDocument>;
  let emitter: ReturnType<typeof createMockEventEmitter>;
  let service: IdentityEntitlementsService;

  beforeAll(async () => {
    await connectTestDb();
    // Indexes are irrelevant here (and the correlationId partial index is rejected by the in-memory server).
    mongoose.set('autoIndex', false);
    identityModel = mongoose.model(
      'Identity',
      IdentitySchema,
    ) as unknown as Model<IdentityDocument>;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(() => {
    emitter = createMockEventEmitter();
    service = new IdentityEntitlementsService(
      identityModel,
      emitter as unknown as DomainEventEmitterService,
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  async function createIdentity(
    tenantId: string,
    provisioning: Array<Pick<ProvisioningState, 'targetSystem' | 'status'>> = [],
  ): Promise<string> {
    const doc = await withTenantContext(tenantId, () =>
      identityModel.create({
        tenantId,
        profile: { firstName: 'Ada', lastName: 'Lovelace', email: `ada@${tenantId}.example` },
        provisioning,
      }),
    );
    return String(doc._id);
  }

  describe('tenant isolation', () => {
    it('returns null for an identity that belongs to another tenant and queries no handlers', async () => {
      const id = await createIdentity(TENANT_A);

      const result = await withTenantContext(TENANT_B, () => service.getEntitlements(id));

      expect(result).toBeNull();
      expect(emitter.emitAndWait).not.toHaveBeenCalled();
    });

    it('returns entitlements for the identity in its own tenant', async () => {
      const id = await createIdentity(TENANT_A);
      emitter.emitAndWait.mockResolvedValue([handlerResult([policyGrant()])]);

      const result = await withTenantContext(TENANT_A, () => service.getEntitlements(id));

      expect(result?.identityId).toBe(id);
      expect(result?.entitlements).toHaveLength(1);
      expect(emitter.emitAndWait).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_ENTITLEMENTS_QUERY,
        id,
        { identityId: id },
      );
    });

    it('requires a tenant context', async () => {
      const id = await createIdentity(TENANT_A);
      await expect(service.getEntitlements(id)).rejects.toThrow('No tenant context');
    });
  });

  it('returns null for a soft-deleted identity', async () => {
    const id = await createIdentity(TENANT_A);
    await withTenantContext(TENANT_A, () =>
      identityModel.updateOne({ _id: id }, { deletedAt: new Date() }).exec(),
    );

    const result = await withTenantContext(TENANT_A, () => service.getEntitlements(id));

    expect(result).toBeNull();
  });

  it('derives policy grant status from the target system provisioning state', async () => {
    const id = await createIdentity(TENANT_A, [
      { targetSystem: 'entra', status: 'SYNCED' },
      { targetSystem: 'active-directory', status: 'DEPROVISIONED' },
      { targetSystem: 'okta', status: 'ERROR' },
    ]);
    emitter.emitAndWait.mockResolvedValue([
      handlerResult([
        policyGrant({ targetSystem: 'entra-id', entitlement: 'SG-Eng' }),
        policyGrant({ targetSystem: 'ad', entitlement: 'CN=Eng' }),
        policyGrant({ targetSystem: 'okta', entitlement: 'okta-eng' }),
        policyGrant({ targetSystem: 'github', entitlement: 'eng-team' }),
      ]),
    ]);

    const result = await withTenantContext(TENANT_A, () => service.getEntitlements(id));

    const statusBy = Object.fromEntries(
      (result?.entitlements ?? []).map((e) => [e.entitlement, e.status]),
    );
    expect(statusBy).toEqual({
      'SG-Eng': 'Active', // entra-id matches provisioning target 'entra' (SYNCED)
      'CN=Eng': 'Revoked', // ad matches 'active-directory' (DEPROVISIONED)
      'okta-eng': 'Pending', // provisioning failed: not in place yet
      'eng-team': 'Pending', // never provisioned to github
    });
  });

  it('derives request grant status from the access request status', async () => {
    const id = await createIdentity(TENANT_A, [{ targetSystem: 'entra', status: 'SYNCED' }]);
    emitter.emitAndWait.mockResolvedValue([
      handlerResult([
        policyGrant({
          grantedBy: 'request',
          source: 'Access request AR-1',
          entitlement: 'Finance-RO',
          requestStatus: 'ACTIVE',
        }),
        policyGrant({
          grantedBy: 'request',
          source: 'Access request AR-2',
          entitlement: 'Finance-RW',
          requestStatus: 'PROVISIONING',
        }),
      ]),
    ]);

    const result = await withTenantContext(TENANT_A, () => service.getEntitlements(id));

    expect(result?.entitlements.map((e) => [e.entitlement, e.status])).toEqual([
      ['Finance-RO', 'Active'],
      ['Finance-RW', 'Pending'],
    ]);
  });

  it('carries the end date of access a time-bound request granted', async () => {
    const id = await createIdentity(TENANT_A);
    emitter.emitAndWait.mockResolvedValue([
      handlerResult([
        policyGrant({
          grantedBy: 'request',
          source: 'Access request AR-3',
          requestStatus: 'ACTIVE',
          expiresAt: '2027-06-01T00:00:00.000Z',
        }),
        policyGrant(),
      ]),
    ]);

    const result = await withTenantContext(TENANT_A, () => service.getEntitlements(id));

    expect(result?.entitlements.map((e) => [e.grantedBy, e.expiresAt])).toEqual([
      ['request', '2027-06-01T00:00:00.000Z'],
      ['policy', undefined],
    ]);
    expect(result?.entitlements[1]).not.toHaveProperty('expiresAt');
  });

  it('merges grants from every handler and ignores results of unrelated listeners', async () => {
    const id = await createIdentity(TENANT_A);
    emitter.emitAndWait.mockResolvedValue([
      undefined, // wildcard listeners (audit, realtime, webhooks) return nothing
      handlerResult([policyGrant()]),
      handlerResult([
        policyGrant({
          grantedBy: 'request',
          source: 'Access request AR-9',
          requestStatus: 'ACTIVE',
        }),
      ]),
      { kind: 'something-else', grants: [policyGrant({ entitlement: 'ignored' })] },
    ]);

    const result = await withTenantContext(TENANT_A, () => service.getEntitlements(id));

    expect(result?.entitlements).toEqual([
      {
        id: 'policy:Engineering birthright:entra-id:group:SG-Engineering',
        entitlement: 'SG-Engineering',
        type: 'group',
        source: 'Engineering birthright',
        targetSystem: 'entra-id',
        grantedBy: 'policy',
        status: 'Pending',
      },
      {
        id: 'request:Access request AR-9:entra-id:group:SG-Engineering',
        entitlement: 'SG-Engineering',
        type: 'group',
        source: 'Access request AR-9',
        targetSystem: 'entra-id',
        grantedBy: 'request',
        status: 'Active',
      },
    ]);
  });

  it('returns an empty list when no handler reports grants', async () => {
    const id = await createIdentity(TENANT_A);

    const result = await withTenantContext(TENANT_A, () => service.getEntitlements(id));

    expect(result).toEqual({ identityId: id, entitlements: [] });
  });
});
