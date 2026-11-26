/**
 * The nightly credential rotation run (credentialRotationWorkflow's one activity) on in-memory
 * MongoDB with the tenant plugin, the real credential inventory and policy services and the real
 * CredentialActivities, the Entra ID and AD connectors mocked.
 *
 * Proves:
 *   - Nothing is reset: a due credential is reported (credential.expiring_soon with a negative
 *     daysRemaining and the reason) and stays due, also under a policy with rotation on. Before,
 *     the run reset the password to a generated value and threw the value away.
 *   - The run fills credential_inventory from the targets first: one row per identity and SYNCED
 *     Entra ID or AD account, its status from the applicable policy's maximum password age.
 *     Before, nothing wrote the inventory, so the run, the expiring list and the compliance summary
 *     worked on nothing.
 *   - An account that cannot be judged gets UNKNOWN with the reason; none is skipped.
 *   - Rows of accounts the identity no longer has are removed.
 *   - The schedule's run covers every active tenant: the workflow lists them and runs each in its
 *     own call; a run from before that patch calls once without a tenant. Before, that call
 *     failed at once on the empty tenant id.
 *   - Each tenant's run is reported once with credential.inventory_updated, counts only.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import {
  Identity,
  IdentityDocument,
  IdentitySchema,
} from '../modules/identity/schemas/identity.schema';
import {
  CredentialInventory,
  CredentialInventoryDocument,
  CredentialInventorySchema,
} from '../modules/credential-lifecycle/schemas/credential-inventory.schema';
import {
  CredentialPolicy,
  CredentialPolicySchema,
} from '../modules/credential-lifecycle/schemas/credential-policy.schema';
import { CredentialInventoryService } from '../modules/credential-lifecycle/credential-inventory.service';
import { CredentialPolicyService } from '../modules/credential-lifecycle/credential-policy.service';
import type { CreateCredentialPolicyDto } from '../modules/credential-lifecycle/dtos/credential-lifecycle.dto';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { ConfigActivities } from './config.activities';
import { CredentialActivities } from './credential.activities';
import { CredentialRotationActivities } from './credential-rotation.activities';
import { CredentialInventoryRefresh } from './credential-inventory-refresh';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-24T03:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const AD_CONFIG = { host: 'ldap.a.example', baseDn: 'DC=a,DC=example' };
const NO_RESET_REASON =
  'Not reset: automatic reset needs secret storage, which EuroID does not have. ' +
  'Change the password in the target system.';

describe('Credential rotation run (MongoDB)', () => {
  let moduleRef: TestingModule;
  let activities: CredentialRotationActivities;
  let identities: Model<IdentityDocument>;
  let inventory: Model<CredentialInventoryDocument>;
  let policies: CredentialPolicyService;
  const events = { emit: jest.fn() };
  const entra = {
    isConfiguredForTenant: jest.fn(),
    getCredentialState: jest.fn(),
    getMfaStatus: jest.fn(),
  };
  const ad = { getCredentialState: jest.fn() };
  const config = { getConnectorConfig: jest.fn() };
  const tenants = { findAll: jest.fn() };
  /** passwordLastSet per account id, as the targets report it. */
  let lastSet: Record<string, Date | undefined>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: CredentialInventory.name, schema: CredentialInventorySchema },
          { name: CredentialPolicy.name, schema: CredentialPolicySchema },
        ]),
      ],
      providers: [
        CredentialRotationActivities,
        CredentialInventoryRefresh,
        CredentialActivities,
        CredentialInventoryService,
        CredentialPolicyService,
        { provide: EntraService, useValue: entra },
        { provide: AdService, useValue: ad },
        { provide: ConfigActivities, useValue: config },
        { provide: TenantService, useValue: tenants },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    activities = moduleRef.get(CredentialRotationActivities);
    identities = moduleRef.get(getModelToken(Identity.name));
    inventory = moduleRef.get(getModelToken(CredentialInventory.name));
    policies = moduleRef.get(CredentialPolicyService);
  });

  beforeEach(async () => {
    lastSet = {};
    events.emit.mockReset();
    entra.isConfiguredForTenant.mockReset().mockResolvedValue(true);
    entra.getCredentialState
      .mockReset()
      .mockImplementation(async (id: string) => ({ passwordLastSet: lastSet[id] }));
    entra.getMfaStatus.mockReset().mockResolvedValue({ enrolled: true, methods: ['FIDO2'] });
    ad.getCredentialState
      .mockReset()
      .mockImplementation(async (_cfg: unknown, id: string) => ({ passwordLastSet: lastSet[id] }));
    config.getConnectorConfig.mockReset().mockResolvedValue(AD_CONFIG);
    tenants.findAll.mockReset().mockResolvedValue([]);
    for (const model of [
      identities,
      inventory,
      moduleRef.get(getModelToken(CredentialPolicy.name)),
    ])
      await (model as Model<unknown>).deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /** An identity with these provisioning entries (system -> status) and account ids. */
  async function identity(
    tenantId: string,
    name: string,
    provisioning: Record<string, string>,
    accounts: Record<string, string> = {},
    employmentType?: string,
  ): Promise<string> {
    const doc = await withTenantContext(tenantId, () =>
      identities.create({
        tenantId,
        profile: {
          firstName: name,
          lastName: 'Test',
          email: `${name}@${tenantId}.example`,
          ...(employmentType ? { employmentType } : {}),
        },
        sources: Object.entries(accounts).map(([sourceName, externalId]) => ({
          sourceName,
          externalId,
          sourceRole: 'target',
        })),
        provisioning: Object.entries(provisioning).map(([targetSystem, status]) => ({
          targetSystem,
          status,
        })),
      }),
    );
    return String(doc._id);
  }

  async function policy(tenantId: string, dto: Partial<CreateCredentialPolicyDto> = {}) {
    await withTenantContext(tenantId, () =>
      policies.create(tenantId, {
        name: 'Standard',
        passwordPolicy: { maxAgeDays: 90, minLength: 16, requireComplexity: true, preventReuse: 5 },
        rotationPolicy: {
          enabled: false,
          intervalDays: 90,
          notifyDaysBefore: 14,
          vaultStorage: false,
        },
        isActive: true,
        ...dto,
      }),
    );
  }

  const rows = (tenantId: string) =>
    inventory.find({ tenantId }).sort({ identityId: 1, targetSystem: 1 }).lean().exec();
  const rowOf = async (tenantId: string, identityId: string, targetSystem: string) =>
    inventory.findOne({ tenantId, identityId, targetSystem }).lean().exec();
  const run = (tenantId = A, now = NOW) =>
    activities.runCredentialRotationBatch(tenantId, now.toISOString(), 50);
  const emitted = (type: DomainEventType) =>
    events.emit.mock.calls.filter(([t]) => t === type).map(([, , payload]) => payload);

  it('reports a due credential and never resets it, also under a policy with rotation on', async () => {
    await policy(A, {
      rotationPolicy: {
        enabled: true,
        intervalDays: 90,
        notifyDaysBefore: 14,
        vaultStorage: false,
      },
    });
    const svc = await identity(
      A,
      'svc',
      { 'entra-id': 'SYNCED' },
      { 'entra-id': 'obj-svc' },
      'SERVICE_ACCOUNT',
    );
    const ada = await identity(A, 'ada', { ad: 'SYNCED' }, { ad: 'CN=Ada Lovelace,OU=Staff' });
    lastSet['obj-svc'] = daysAgo(93);
    lastSet['CN=Ada Lovelace,OU=Staff'] = daysAgo(100);
    // Rows as an earlier run left them: due since three and ten days
    await withTenantContext(A, async () => {
      await inventory.create({
        tenantId: A,
        identityId: svc,
        targetSystem: 'entra-id',
        externalId: 'obj-svc',
        password: { lastRotated: daysAgo(93), nextRotation: daysAgo(3), status: 'EXPIRED' },
      });
      await inventory.create({
        tenantId: A,
        identityId: ada,
        targetSystem: 'ad',
        externalId: 'CN=Ada Lovelace,OU=Staff',
        password: { lastRotated: daysAgo(100), nextRotation: daysAgo(10), status: 'EXPIRED' },
      });
    });

    const result = await run();

    // Only the run's reports go out (no credential.rotated), and the services the run reads
    // through have no password reset at all (removed with ICredentialManagement.resetPassword)
    expect(new Set(events.emit.mock.calls.map(([type]) => type))).toEqual(
      new Set([
        DomainEventType.CREDENTIAL_INVENTORY_UPDATED,
        DomainEventType.CREDENTIAL_EXPIRING_SOON,
      ]),
    );
    for (const service of [EntraService, AdService]) {
      expect(Object.getOwnPropertyNames(service.prototype)).not.toContain('resetPassword');
    }
    expect(result).toMatchObject({ rotated: 0, overdue: 2 });
    // Still due: the next rotation date is not pushed forward
    expect((await rowOf(A, svc, 'entra-id'))?.password).toMatchObject({
      status: 'EXPIRED',
      nextRotation: daysAgo(3),
      lastRotated: daysAgo(93),
      rotationCount: 0,
    });
    expect((await rowOf(A, ada, 'ad'))?.password).toMatchObject({
      status: 'EXPIRED',
      nextRotation: daysAgo(10),
    });
    // Reported with the reason; the AD account's DN is masked in the event (it names the person)
    expect(emitted(DomainEventType.CREDENTIAL_EXPIRING_SOON)).toEqual(
      expect.arrayContaining([
        {
          identityId: svc,
          targetSystem: 'entra-id',
          externalId: 'obj-svc',
          expiresAt: daysAgo(3).toISOString(),
          daysRemaining: -3,
          reason: NO_RESET_REASON,
        },
        {
          identityId: ada,
          targetSystem: 'ad',
          externalId: 'CN=•••,OU=Staff',
          expiresAt: daysAgo(10).toISOString(),
          daysRemaining: -10,
          reason: NO_RESET_REASON,
        },
      ]),
    );
    expect(emitted(DomainEventType.CREDENTIAL_EXPIRING_SOON)).toHaveLength(2);
  });

  it('fills the inventory from the targets, one row per identity and SYNCED account', async () => {
    await policy(A);
    const ada = await identity(A, 'ada', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-ada' });
    const bob = await identity(
      A,
      'bob',
      { entra: 'SYNCED', ad: 'SYNCED' },
      { entra: 'obj-bob', ad: 'CN=Bob,OU=Staff' },
    );
    await identity(A, 'cy', { 'entra-id': 'PENDING' }, { 'entra-id': 'obj-cy' });
    await identity(A, 'dee', { github: 'SYNCED' }, { github: 'dee-gh' });
    lastSet['obj-ada'] = daysAgo(10);
    lastSet['obj-bob'] = daysAgo(80);
    lastSet['CN=Bob,OU=Staff'] = daysAgo(100);

    const result = await run();

    expect(await rows(A)).toEqual(
      [
        {
          identityId: ada,
          targetSystem: 'entra-id',
          externalId: 'obj-ada',
          status: 'COMPLIANT',
          lastRotated: daysAgo(10),
          nextRotation: new Date(daysAgo(10).getTime() + 90 * DAY),
          mfa: { enrolled: true, methods: ['FIDO2'] },
        },
        {
          identityId: bob,
          targetSystem: 'ad',
          externalId: 'CN=Bob,OU=Staff',
          status: 'EXPIRED',
          lastRotated: daysAgo(100),
          nextRotation: daysAgo(10),
        },
        {
          identityId: bob,
          targetSystem: 'entra-id',
          externalId: 'obj-bob',
          status: 'EXPIRING_SOON',
          lastRotated: daysAgo(80),
          nextRotation: new Date(daysAgo(80).getTime() + 90 * DAY),
          mfa: { enrolled: true, methods: ['FIDO2'] },
        },
      ]
        .sort((x, y) =>
          (x.identityId + x.targetSystem).localeCompare(y.identityId + y.targetSystem),
        )
        .map(({ status, lastRotated, nextRotation, mfa, ...row }) =>
          expect.objectContaining({
            ...row,
            observedAt: NOW,
            password: expect.objectContaining({ status, lastRotated, nextRotation }),
            ...(mfa ? { mfa: expect.objectContaining(mfa) } : {}),
          }),
        ),
    );
    expect(ad.getCredentialState).toHaveBeenCalledWith(AD_CONFIG, 'CN=Bob,OU=Staff');
    expect(entra.getCredentialState).not.toHaveBeenCalledWith('obj-cy');
    expect(result).toMatchObject({ observed: 3, unknown: 0, overdue: 1, notified: 1 });
    expect(emitted(DomainEventType.CREDENTIAL_EXPIRING_SOON)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identityId: bob, targetSystem: 'entra-id', daysRemaining: 10 }),
      ]),
    );
  });

  it('records UNKNOWN with the reason for every account it cannot judge', async () => {
    const noId = await identity(A, 'noid', { 'entra-id': 'SYNCED' });
    const broken = await identity(A, 'broken', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-x' });
    const noDate = await identity(A, 'nodate', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-n' });
    const ok = await identity(A, 'ok', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-ok' });
    entra.getCredentialState.mockImplementation(async (id: string) => {
      if (id === 'obj-x') throw new Error('Graph 404: user broken@tenant-a.example not found');
      return { passwordLastSet: id === 'obj-ok' ? daysAgo(5) : undefined };
    });

    // No policy at all yet
    expect(await run()).toMatchObject({ observed: 4, unknown: 4 });
    const reason = async (id: string) => (await rowOf(A, id, 'entra-id'))?.password;
    expect(await reason(noId)).toMatchObject({
      status: 'UNKNOWN',
      statusReason: 'EuroID holds no Entra ID account id for this identity',
    });
    expect(await reason(broken)).toMatchObject({
      status: 'UNKNOWN',
      statusReason:
        'Entra ID could not read the account: Graph 404: user b•••@tenant-a.example not found',
    });
    expect(await reason(ok)).toMatchObject({
      status: 'UNKNOWN',
      statusReason: 'No active credential policy applies to Entra ID',
      lastRotated: daysAgo(5),
    });

    await policy(A);
    await run();
    expect(await reason(noDate)).toMatchObject({
      status: 'UNKNOWN',
      statusReason: 'Entra ID reports no password change date for this account',
    });
    const okRow = await reason(ok);
    expect(okRow).toMatchObject({ status: 'COMPLIANT' });
    expect(okRow?.statusReason).toBeUndefined();

    // Not configured: each account still gets its row and the reason
    entra.isConfiguredForTenant.mockResolvedValue(false);
    config.getConnectorConfig.mockResolvedValue(null);
    const adOnly = await identity(A, 'adonly', { ad: 'SYNCED' }, { ad: 'CN=Ad,OU=Staff' });
    await run();
    expect(await reason(ok)).toMatchObject({
      status: 'UNKNOWN',
      statusReason: 'Entra ID is not configured for this tenant',
    });
    expect((await rowOf(A, adOnly, 'ad'))?.password).toMatchObject({
      status: 'UNKNOWN',
      statusReason: 'Active Directory is not configured for this tenant',
    });
  });

  it('uses the policy for the system and employment type, and drops rows of removed accounts', async () => {
    await policy(A);
    await policy(A, {
      name: 'AD service accounts',
      targetScope: { connectorTypes: ['ad'], employmentTypes: ['SERVICE_ACCOUNT'] },
      passwordPolicy: { maxAgeDays: 365, minLength: 24, requireComplexity: true, preventReuse: 5 },
    });
    const svc = await identity(
      A,
      'svc',
      { ad: 'SYNCED', 'entra-id': 'SYNCED' },
      { ad: 'CN=svc-backup,OU=Service', 'entra-id': 'obj-svc' },
      'SERVICE_ACCOUNT',
    );
    lastSet['CN=svc-backup,OU=Service'] = daysAgo(200);
    lastSet['obj-svc'] = daysAgo(200);

    await run();
    expect((await rowOf(A, svc, 'ad'))?.password?.status).toBe('COMPLIANT');
    expect((await rowOf(A, svc, 'entra-id'))?.password?.status).toBe('EXPIRED');

    await identities
      .updateOne(
        { _id: svc, 'provisioning.targetSystem': 'entra-id' },
        { $set: { 'provisioning.$.status': 'DEPROVISIONED' } },
      )
      .setOptions({ skipTenantScope: true });
    await run(A, new Date(NOW.getTime() + DAY));
    expect(await rowOf(A, svc, 'entra-id')).toBeNull();
    expect(await rowOf(A, svc, 'ad')).not.toBeNull();
  });

  // CREDENTIAL_INVENTORY_REFRESH_LIMIT per tenant and run: a large tenant over several nights.
  it('reads at most the limit per run, accounts never read or read longest ago first', async () => {
    await policy(A);
    const ids = [];
    for (const name of ['a1', 'a2', 'a3']) {
      ids.push(await identity(A, name, { 'entra-id': 'SYNCED' }, { 'entra-id': `obj-${name}` }));
      lastSet[`obj-${name}`] = daysAgo(1);
    }
    const refresh = moduleRef.get(CredentialInventoryRefresh);
    const readAt = async () =>
      Object.fromEntries((await rows(A)).map((r) => [r.identityId, r.observedAt?.toISOString()]));

    await withTenantContext(A, () => refresh.refreshTenant(A, NOW, 2));
    expect(await readAt()).toEqual({ [ids[0]]: NOW.toISOString(), [ids[1]]: NOW.toISOString() });

    const next = new Date(NOW.getTime() + DAY);
    expect(await withTenantContext(A, () => refresh.refreshTenant(A, next, 2))).toEqual({
      observed: 2,
      unknown: 0,
      // The one never read gets its first row; the other stays COMPLIANT
      changed: 1,
      removed: 0,
    });
    // The one never read, then the first of the two read the night before
    expect(await readAt()).toEqual({
      [ids[0]]: next.toISOString(),
      [ids[1]]: NOW.toISOString(),
      [ids[2]]: next.toISOString(),
    });
  });

  // Hunt 06 F10 (b): the cap took the same earliest-due rows every night, so a due credential
  // beyond it was never reported. Each run now reports the ones reported longest ago first.
  it('reports due credentials beyond the batch size on later runs, least recently reported first', async () => {
    await policy(A);
    const ids: string[] = [];
    for (const [name, days] of [
      ['d1', 102],
      ['d2', 101],
      ['d3', 100],
    ] as const) {
      ids.push(await identity(A, name, { 'entra-id': 'SYNCED' }, { 'entra-id': `obj-${name}` }));
      lastSet[`obj-${name}`] = daysAgo(days);
    }
    const reported = () =>
      (emitted(DomainEventType.CREDENTIAL_EXPIRING_SOON) as Array<{ identityId: string }>).map(
        (e) => e.identityId,
      );

    await activities.runCredentialRotationBatch(A, NOW.toISOString(), 2);
    expect(reported()).toEqual([ids[0], ids[1]]);

    events.emit.mockReset();
    const next = new Date(NOW.getTime() + DAY);
    await activities.runCredentialRotationBatch(A, next.toISOString(), 2);
    // The one left out first, then the earliest due of the two reported the night before
    expect(reported()).toEqual([ids[2], ids[0]]);
  });

  // FOLLOWUPS 2026-11-25 (event-types.ts:235): declared and offered to webhooks, never emitted
  it('reports each run of a tenant once with credential.inventory_updated, in counts only', async () => {
    await policy(A);
    const ada = await identity(A, 'ada', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-ada' });
    const bob = await identity(A, 'bob', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-bob' });
    const cy = await identity(A, 'cy', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-cy' });
    await identity(A, 'noid', { 'entra-id': 'SYNCED' });
    lastSet['obj-ada'] = daysAgo(10);
    lastSet['obj-bob'] = daysAgo(100);
    lastSet['obj-cy'] = daysAgo(20);
    const stored = (identityId: string, targetSystem: string, password: object) =>
      withTenantContext(A, () =>
        inventory.create({ tenantId: A, identityId, targetSystem, externalId: 'x', password }),
      );
    // As an earlier run left them: bob compliant then, cy compliant still
    await stored(bob, 'entra-id', { status: 'COMPLIANT', nextRotation: daysAgo(-60) });
    await stored(cy, 'entra-id', { status: 'COMPLIANT', nextRotation: daysAgo(-70) });
    // An account ada no longer has, and one this run does not read whose due date has passed
    await stored(ada, 'ad', { status: 'COMPLIANT', nextRotation: daysAgo(-5) });
    await stored(ada, 'okta', { status: 'COMPLIANT', nextRotation: daysAgo(1) });

    await run();

    const updates = events.emit.mock.calls.filter(
      ([type]) => type === DomainEventType.CREDENTIAL_INVENTORY_UPDATED,
    );
    expect(updates).toEqual([
      [
        DomainEventType.CREDENTIAL_INVENTORY_UPDATED,
        A,
        // ada, bob, cy and noid read; ada's new row, bob now EXPIRED, noid's new UNKNOWN row and
        // the okta row moved to EXPIRED changed; ada's AD row removed
        { refreshed: 4, changed: 4, unknown: 1, removed: 1 },
      ],
    ]);
  });

  it('lists the active tenants, which the workflow then runs one call each', async () => {
    tenants.findAll.mockResolvedValue([
      { tenantId: A, status: 'active' },
      { tenantId: 'tenant-off', status: 'suspended' },
      { tenantId: B, status: 'active' },
    ]);
    expect(await activities.listCredentialRotationTenants()).toEqual([A, B]);
  });

  // A run started before the patch credential-rotation:per-tenant calls once with tenant ''
  it('runs every active tenant in one call when the run names none', async () => {
    tenants.findAll.mockResolvedValue([
      { tenantId: A, status: 'active' },
      { tenantId: 'tenant-off', status: 'suspended' },
      { tenantId: B, status: 'active' },
    ]);
    await policy(A);
    await policy(B);
    const ada = await identity(A, 'ada', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-a' });
    const ben = await identity(B, 'ben', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-b' });
    await identity('tenant-off', 'off', { 'entra-id': 'SYNCED' }, { 'entra-id': 'obj-off' });
    lastSet['obj-a'] = daysAgo(1);
    lastSet['obj-b'] = daysAgo(1);

    expect(await run('')).toMatchObject({ observed: 2 });
    expect((await rows(A)).map((r) => r.identityId)).toEqual([ada]);
    expect((await rows(B)).map((r) => r.identityId)).toEqual([ben]);
    expect(await rows('tenant-off')).toEqual([]);
    // One report per tenant run
    expect(
      events.emit.mock.calls
        .filter(([type]) => type === DomainEventType.CREDENTIAL_INVENTORY_UPDATED)
        .map(([, tenantId]) => tenantId),
    ).toEqual([A, B]);
  });
});
