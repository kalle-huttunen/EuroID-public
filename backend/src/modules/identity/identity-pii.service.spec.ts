import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import type { AuditService } from '../audit/audit.service';
import { IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { IdentityPiiService } from './identity-pii.service';

// Register tenant scoping plugin (normally done by TenantModule at import time)
mongoose.plugin(tenantPlugin);

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PERSONAL_EMAIL = 'ada.lovelace@home.example';

describe('IdentityPiiService.reveal', () => {
  let identityModel: Model<IdentityDocument>;
  let auditLog: jest.Mock;
  let service: IdentityPiiService;

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
    auditLog = jest.fn().mockResolvedValue({});
    service = new IdentityPiiService(identityModel, { log: auditLog } as unknown as AuditService);
  });

  afterEach(async () => {
    await clearTestDb();
  });

  async function createIdentity(tenantId: string, profile: Record<string, unknown> = {}) {
    const doc = await withTenantContext(tenantId, () =>
      identityModel.create({
        tenantId,
        profile: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: `ada@${tenantId}.example`,
          personalEmail: PERSONAL_EMAIL,
          mobilePhone: '+358 40 123 4567',
          ...profile,
        },
      }),
    );
    return String(doc._id);
  }

  it('returns the clear value and writes the PII_REVEALED audit entry first', async () => {
    const id = await createIdentity(TENANT_A);

    const result = await withTenantContext(TENANT_A, () =>
      service.reveal(id, 'personalEmail', 'operator@corp.example'),
    );

    expect(result).toEqual({ identityId: id, field: 'personalEmail', value: PERSONAL_EMAIL });
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith({
      action: 'PII_REVEALED',
      severity: 'info',
      actor: 'operator@corp.example',
      resourceType: 'identity',
      resourceId: id,
      resourceName: 'personalEmail',
      description: 'PII field "personalEmail" revealed by operator@corp.example',
      payload: { metadata: { field: 'personalEmail', identityId: id } },
      tenantId: TENANT_A,
    });
    // The audit record names the field, never the value.
    expect(JSON.stringify(auditLog.mock.calls[0][0])).not.toContain(PERSONAL_EMAIL);
  });

  it('returns no value when the audit entry cannot be written', async () => {
    const id = await createIdentity(TENANT_A);
    auditLog.mockRejectedValueOnce(new Error('audit store down'));

    await expect(
      withTenantContext(TENANT_A, () => service.reveal(id, 'personalEmail', 'op@corp.example')),
    ).rejects.toThrow('audit store down');
  });

  it('refuses a cross-tenant reveal: null, no audit entry', async () => {
    const id = await createIdentity(TENANT_A);

    const result = await withTenantContext(TENANT_B, () =>
      service.reveal(id, 'personalEmail', 'op@tenant-b.example'),
    );

    expect(result).toBeNull();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('refuses a soft-deleted identity', async () => {
    const id = await createIdentity(TENANT_A);
    await withTenantContext(TENANT_A, () =>
      identityModel.updateOne({ _id: id }, { deletedAt: new Date() }).exec(),
    );

    const result = await withTenantContext(TENANT_A, () =>
      service.reveal(id, 'personalEmail', 'op@corp.example'),
    );

    expect(result).toBeNull();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('returns null for an empty field (the reveal is still audited)', async () => {
    const id = await createIdentity(TENANT_A, { workPhone: undefined });

    const result = await withTenantContext(TENANT_A, () =>
      service.reveal(id, 'workPhone', 'op@corp.example'),
    );

    expect(result).toEqual({ identityId: id, field: 'workPhone', value: null });
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it('requires a tenant context', async () => {
    const id = await createIdentity(TENANT_A);
    await expect(service.reveal(id, 'personalEmail', 'op@corp.example')).rejects.toThrow(
      'No tenant context',
    );
  });
});
