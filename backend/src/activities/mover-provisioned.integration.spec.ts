/**
 * Which target systems the mover treats as provisioned (provisionedSystems, the source of the
 * no-account outcome), read from provisioning entries that IdentityProvisioningService wrote on
 * in-memory MongoDB with the real Identity schema and tenant plugin.
 *
 * Plan 2.0dq: an entry SYNCED before onboarding:writeback-until-complete (no writebackComplete)
 * whose mover run failed there became ERROR, and the next mover run reported the system
 * no-account, completed and advanced the access baseline: that system's change, possibly a
 * removal of the old department's access, was never retried. A system stays provisioned once
 * provisioned (`provisionedAt`); only a deprovision takes that away.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { createMockLoggerFactory } from '@testing/test-helpers';
import {
  Identity,
  IdentitySchema,
  IdentityDocument,
} from '../modules/identity/schemas/identity.schema';
import {
  IdentityProvisioningService,
  provisionedSystems,
} from '../modules/identity/identity-provisioning.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
type Status = 'SYNCING' | 'SYNCED' | 'ERROR' | 'DEPROVISIONED';

describe('Systems the mover treats as provisioned (MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: IdentityProvisioningService;
  let identities: Model<IdentityDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        IdentityProvisioningService,
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
      ],
    }).compile();
    service = moduleRef.get(IdentityProvisioningService);
    identities = moduleRef.get(getModelToken(Identity.name));
  });

  beforeEach(async () => {
    await identities.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  let created = 0;
  async function identity(
    provisioning: Array<Record<string, unknown>>,
    sources: Array<Record<string, unknown>> = [],
  ): Promise<string> {
    created++;
    const doc = await withTenantContext(A, () =>
      identities.create({
        tenantId: A,
        profile: { firstName: 'Ada', lastName: 'Test', email: `ada${created}@a.example` },
        provisioning,
        sources,
      }),
    );
    return String(doc._id);
  }

  const setStatus = (id: string, system: string, status: Status, error?: string) =>
    withTenantContext(A, () => service.updateProvisioningState(id, system, status, error));

  /** The identity as the mover's evaluateMoverChange reads it (hydrated, by id). */
  async function provisioned(id: string): Promise<string[]> {
    const doc = await withTenantContext(A, () => identities.findById(id).exec());
    return provisionedSystems(doc!);
  }

  async function entryOf(id: string, system: string) {
    const doc = await identities.findById(id).setOptions({ skipTenantScope: true }).lean().exec();
    return doc?.provisioning.find((p) => p.targetSystem === system);
  }

  it('keeps a system SYNCED before the marker provisioned after a mover run failed there', async () => {
    // Provisioned before onboarding:writeback-until-complete: SYNCED, no writebackComplete
    const id = await identity([{ targetSystem: 'ad', status: 'SYNCED' }]);

    // The mover's run there: SYNCING, then the target refuses the change
    await setStatus(id, 'ad', 'SYNCING');
    await setStatus(id, 'ad', 'ERROR', 'ad: insufficient access rights');

    expect((await entryOf(id, 'ad'))?.status).toBe('ERROR');
    expect(await provisioned(id)).toEqual(['ad']);
  });

  it('records the marker at the first SYNCED and keeps it through a later ERROR', async () => {
    const id = await identity([]);

    await setStatus(id, 'okta', 'SYNCING');
    expect(await provisioned(id)).toEqual([]);
    expect((await entryOf(id, 'okta'))?.provisionedAt).toBeUndefined();

    await setStatus(id, 'okta', 'SYNCED');
    const marker = (await entryOf(id, 'okta'))?.provisionedAt;
    expect(marker).toBeInstanceOf(Date);

    await setStatus(id, 'okta', 'SYNCING');
    await setStatus(id, 'okta', 'ERROR', 'okta: Okta refused the change (HTTP 403)');
    expect((await entryOf(id, 'okta'))?.provisionedAt).toEqual(marker);
    expect(await provisioned(id)).toEqual(['okta']);

    // A later SYNCED keeps the first time
    await setStatus(id, 'okta', 'SYNCED');
    expect((await entryOf(id, 'okta'))?.provisionedAt).toEqual(marker);
  });

  it('counts an ERROR entry whose account id the target wrote back, never an HR employee id', async () => {
    const id = await identity(
      [
        // Onboarding created the Entra ID account, wrote it back, then a group change failed
        { targetSystem: 'entra-id', status: 'ERROR', errorMsg: 'entra-id: group not found' },
        // Onboarding failed before Okta created anything; the HR source's id is no account
        { targetSystem: 'okta', status: 'ERROR', errorMsg: 'okta: login already taken' },
      ],
      [
        { sourceName: 'entra-id', externalId: 'obj-1', sourceRole: 'target' },
        { sourceName: 'okta-hr-feed', externalId: 'E100', sourceRole: 'primary-hr' },
      ],
    );

    expect(await provisioned(id)).toEqual(['entra-id']);
  });

  it('a deprovision clears the marker: a rehire whose onboarding fails there has no account', async () => {
    const id = await identity(
      [{ targetSystem: 'ad', status: 'SYNCED', writebackComplete: true }],
      [{ sourceName: 'ad', externalId: 'CN=Ada,OU=Staff', sourceRole: 'target' }],
    );
    await setStatus(id, 'ad', 'SYNCING');
    await setStatus(id, 'ad', 'SYNCED');

    await setStatus(id, 'ad', 'DEPROVISIONED');
    expect((await entryOf(id, 'ad'))?.provisionedAt).toBeNull();
    expect(await provisioned(id)).toEqual([]);

    // Rehired: onboarding tries again and fails. The old writebackComplete and account id
    // describe the account offboarding removed.
    await setStatus(id, 'ad', 'SYNCING');
    await setStatus(id, 'ad', 'ERROR', 'ad: the server is unwilling to perform');
    expect(await provisioned(id)).toEqual([]);

    await setStatus(id, 'ad', 'SYNCED');
    expect(await provisioned(id)).toEqual(['ad']);
  });

  it('a deprovision undoes the writeback, so the next provision writes its new account back', async () => {
    // Okta account written back, then removed by an access review revoke or an expiry
    const id = await identity(
      [{ targetSystem: 'okta', status: 'SYNCED', writebackComplete: true }],
      [{ sourceName: 'okta', externalId: '00u-removed', sourceRole: 'target' }],
    );
    await setStatus(id, 'okta', 'DEPROVISIONED');
    expect(await entryOf(id, 'okta')).toEqual(
      expect.objectContaining({ status: 'DEPROVISIONED', provisionedAt: null }),
    );
    // Onboarding writes back while writebackComplete is not true (writeback-until-complete)
    expect((await entryOf(id, 'okta'))?.writebackComplete).toBe(false);
    expect(await provisioned(id)).toEqual([]);

    // Provisioned again: the removed account's id is no account until the new one is written back
    await setStatus(id, 'okta', 'SYNCING');
    await setStatus(id, 'okta', 'ERROR', 'okta: login already taken');
    expect((await entryOf(id, 'okta'))?.writebackComplete).toBe(false);
    expect(await provisioned(id)).toEqual([]);

    await withTenantContext(A, () =>
      service.updateProvisioningState(id, 'okta', 'SYNCED', undefined, true),
    );
    expect((await entryOf(id, 'okta'))?.writebackComplete).toBe(true);
    expect(await provisioned(id)).toEqual(['okta']);
  });

  it('treats an entry deprovisioned before the marker the same once onboarding writes it', async () => {
    const id = await identity(
      [{ targetSystem: 'ad', status: 'DEPROVISIONED', writebackComplete: true }],
      [{ sourceName: 'ad', externalId: 'CN=Ada,OU=Staff', sourceRole: 'target' }],
    );

    await setStatus(id, 'ad', 'SYNCING');
    expect((await entryOf(id, 'ad'))?.provisionedAt).toBeNull();
    await setStatus(id, 'ad', 'ERROR', 'ad: the server is unwilling to perform');
    expect(await provisioned(id)).toEqual([]);
  });
});
