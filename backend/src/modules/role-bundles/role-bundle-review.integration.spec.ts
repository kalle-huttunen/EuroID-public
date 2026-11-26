/**
 * Role bundles and the two-person policy review (in-memory MongoDB, tenant plugin, the real
 * RoleBundlesService).
 *
 * Hunt 04 F3: PolicyService.update sends a policy back to DRAFT when what it grants changes, so a
 * second policy-admin must activate it again. A PATCH of the role bundle a live policy uses
 * changed what that policy grants without touching the policy: admin A could add Global
 * Administrator to a bundle that admin C had reviewed, and every person the policy matched got it
 * at the next onboarding, mover or reconcile run. A change of a bundle's actions or inheritance
 * now sends every policy that uses it (directly, or through a bundle that inherits it) back to
 * DRAFT with the editor as lastEditedBy.
 *
 * Hunt 04 F12: an action's timeConstraint and targetId passed validation and were dropped on save
 * (the schema had neither), and a bundle another bundle inherits could be deleted, so the
 * inheritor silently lost those actions at the next evaluation.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import {
  Policy,
  PolicySchema,
  PolicyDocument,
  PolicyStatus,
} from '../policy/schemas/policy.schema';
import { RoleBundle, RoleBundleSchema, RoleBundleDocument } from './schemas/role-bundle.schema';
import { RoleBundlesService } from './role-bundles.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const GLOBAL_ADMIN_ACTION = {
  type: 'assign_role',
  target: 'entra-id',
  params: { roleTemplateId: '62e90394-69f5-4237-9190-012177145e10' },
};

describe('Role bundles: an edit sends the live policies that use it back to review (MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: RoleBundlesService;
  let policies: Model<PolicyDocument>;
  let bundles: Model<RoleBundleDocument>;
  const emit = jest.fn();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Policy.name, schema: PolicySchema },
          { name: RoleBundle.name, schema: RoleBundleSchema },
        ]),
      ],
      providers: [RoleBundlesService, { provide: DomainEventEmitterService, useValue: { emit } }],
    }).compile();
    service = moduleRef.get(RoleBundlesService);
    policies = moduleRef.get(getModelToken(Policy.name));
    bundles = moduleRef.get(getModelToken(RoleBundle.name));
  });

  beforeEach(async () => {
    emit.mockClear();
    await policies.deleteMany({}).setOptions({ skipTenantScope: true });
    await bundles.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const inA = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;

  const bundle = (name: string, inheritance: string[] = []) =>
    inA(() =>
      service.create({
        name,
        actions: [{ type: 'assign_group', target: 'entra-id', params: { groupName: 'Staff' } }],
        inheritance,
      }),
    );

  const policy = (name: string, roleBundleId: string, status: PolicyStatus, tenantId = A) =>
    withTenantContext(tenantId, () =>
      policies.create({
        tenantId,
        name,
        status,
        roleBundleId,
        createdBy: 'admin-a@a.example',
        conditionGroups: [
          {
            id: 'g1',
            join: 'AND',
            conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'IT' }],
          },
        ],
        actions: [],
      }),
    );

  const stored = (id: unknown) =>
    policies.findById(id).setOptions({ skipTenantScope: true }).lean().exec();

  it('sends an active policy using the bundle back to DRAFT, the editor as lastEditedBy', async () => {
    const b = await bundle('Helpdesk');
    const p = await policy('IT helpdesk', b.id!, PolicyStatus.ACTIVE);

    await inA(() =>
      service.update(
        b.id!,
        { actions: [{ id: 'a1', ...GLOBAL_ADMIN_ACTION }] },
        'admin-a@a.example',
      ),
    );

    const after = await stored(p._id);
    expect(after?.status).toBe(PolicyStatus.DRAFT);
    expect(after?.lastEditedBy).toBe('admin-a@a.example');
    expect(after?.lastEditedAt).toBeInstanceOf(Date);
    expect(emit).toHaveBeenCalledWith(
      'policy.updated',
      String(p._id),
      { policyId: String(p._id), changedFields: ['status'], previousStatus: PolicyStatus.ACTIVE },
      { actor: 'admin-a@a.example' },
    );
  });

  it('sends back a policy that uses a bundle inheriting the edited one', async () => {
    const parent = await bundle('Base');
    const child = await bundle('Helpdesk', [parent.id!]);
    const grandchild = await bundle('Helpdesk lead', [child.id!]);
    const p = await policy('IT leads', grandchild.id!, PolicyStatus.ACTIVE);

    await inA(() =>
      service.update(
        parent.id!,
        { inheritance: [], actions: [{ ...GLOBAL_ADMIN_ACTION }] },
        'admin-a@a.example',
      ),
    );

    expect((await stored(p._id))?.status).toBe(PolicyStatus.DRAFT);
  });

  it('sends a disabled policy to DRAFT too, so a toggle cannot bring the change live', async () => {
    const b = await bundle('Helpdesk');
    const p = await policy('IT helpdesk', b.id!, PolicyStatus.DISABLED);

    await inA(() => service.update(b.id!, { inheritance: [] }, 'admin-a@a.example'));

    expect((await stored(p._id))?.status).toBe(PolicyStatus.DRAFT);
  });

  it('records the editor on a draft policy, so they cannot activate it', async () => {
    const b = await bundle('Helpdesk');
    const p = await policy('IT helpdesk', b.id!, PolicyStatus.DRAFT);

    await inA(() =>
      service.update(b.id!, { actions: [{ ...GLOBAL_ADMIN_ACTION }] }, 'admin-a@a.example'),
    );

    const after = await stored(p._id);
    expect(after?.status).toBe(PolicyStatus.DRAFT);
    expect(after?.lastEditedBy).toBe('admin-a@a.example');
  });

  it('records an unknown editor as such, so no unknown activator can approve the change', async () => {
    const b = await bundle('Helpdesk');
    const p = await policy('IT helpdesk', b.id!, PolicyStatus.ACTIVE);

    await inA(() => service.update(b.id!, { actions: [{ ...GLOBAL_ADMIN_ACTION }] }));

    expect((await stored(p._id))?.lastEditedBy).toBe('unknown');
  });

  it('leaves the policies live when only the name, description, icon, color or tags change', async () => {
    const b = await bundle('Helpdesk');
    const p = await policy('IT helpdesk', b.id!, PolicyStatus.ACTIVE);

    await inA(() =>
      service.update(
        b.id!,
        {
          name: 'Service desk',
          description: 'd',
          icon: 'TeamOutlined',
          color: '#123456',
          tags: ['it'],
        },
        'admin-a@a.example',
      ),
    );

    const after = await stored(p._id);
    expect(after?.status).toBe(PolicyStatus.ACTIVE);
    expect(after?.lastEditedBy).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('leaves policies of unrelated bundles and of another tenant alone', async () => {
    const b = await bundle('Helpdesk');
    const other = await bundle('Finance');
    const unrelated = await policy('Finance staff', other.id!, PolicyStatus.ACTIVE);
    // Another tenant's policy naming the same bundle id (ids are not shared, but the filter must
    // not reach across tenants either)
    const foreign = await policy('Foreign', b.id!, PolicyStatus.ACTIVE, B);

    await inA(() =>
      service.update(b.id!, { actions: [{ ...GLOBAL_ADMIN_ACTION }] }, 'admin-a@a.example'),
    );

    expect((await stored(unrelated._id))?.status).toBe(PolicyStatus.ACTIVE);
    expect((await stored(foreign._id))?.status).toBe(PolicyStatus.ACTIVE);
  });

  describe('what a bundle holds', () => {
    it('keeps an action’s time constraint and target id, and resolves the time constraint', async () => {
      const b = await inA(() =>
        service.create({
          name: 'Contractors',
          actions: [
            {
              type: 'assign_group',
              target: 'entra-id',
              targetId: 'grp-contractors',
              params: { groupName: 'Contractors' },
              timeConstraint: { durationDays: 90 },
            },
          ],
        }),
      );

      const saved = await bundles.findById(b.id).setOptions({ skipTenantScope: true }).lean();
      expect(saved?.actions[0]).toMatchObject({
        targetId: 'grp-contractors',
        timeConstraint: { durationDays: 90 },
      });
      const resolved = await inA(() => service.resolveWithInheritance(b.id!, A));
      expect(resolved[0].timeConstraint).toEqual({ durationDays: 90 });
    });

    it('refuses to delete a bundle another bundle inherits, and keeps it', async () => {
      const parent = await bundle('Base');
      await bundle('Helpdesk', [parent.id!]);

      await expect(inA(() => service.delete(parent.id!))).rejects.toThrow(
        /inherited by 1 role bundle/,
      );
      expect(
        await bundles.exists({ _id: parent.id }).setOptions({ skipTenantScope: true }),
      ).not.toBeNull();
    });
  });
});
