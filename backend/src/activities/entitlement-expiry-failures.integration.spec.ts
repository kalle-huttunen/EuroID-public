/**
 * How the hourly entitlementExpiryWorkflow removes expired access, and what it does with access
 * it cannot remove (in-memory MongoDB, tenant plugin, the real provisioning-state service, the
 * real per-target deprovision activities offboarding uses, with the AD and SCIM connectors
 * running over mocked clients and the other connectors mocked). `runWorkflow` repeats the
 * activity as the workflow does since the patch entitlement-expiry:continue-past-failures.
 *
 * Proves:
 *   - Entries that cannot be deprovisioned (here: a target offboarding has no deprovision for)
 *     no longer hold the batch: with the batch size at 2 and 2 such identities, a third
 *     identity's expired access is still removed in the same run.
 *   - A failure is recorded on the entry and emitted once per attempt (entitlement.expiry_failed,
 *     a payload its Zod schema accepts); later runs do not try a non-retryable one again.
 *   - A retryable failure (503) is tried again after 1 hour, then 2 hours, not on every run.
 *   - A client error (403) is not retried until the expiry date changes.
 *   - Okta, GitHub and ServiceNow access is removed through offboarding's deprovision (2.0dp:
 *     before, every such entry was parked as not deprovisionable).
 *   - An account already gone counts as removed in every target, as in offboarding: Entra ID
 *     404 for the stored object id, AD "no such object" (LDAP 32, retried forever before 2.0dp),
 *     SCIM 404 (parked before), and a connector answering already-gone.
 *   - A target that keeps no account has nothing to remove; AD without a distinguished name and
 *     Entra ID without a stored id or a user with the email are failures a person must act on.
 *   - Expiry warnings (expiryWarnings, 2.0cv) are still emitted once next to a recorded failure.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getEventSchema } from '@infrastructure/events/event-payload-schemas';
import { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { CredentialGenerationService } from '@infrastructure/secrets/credential-generation.service';
import { createMockLoggerFactory, httpError, closeTestDb, testDbUri } from '@testing';
import { SCIMError } from '@shared/scim/scim.error';
import {
  Identity,
  IdentityDocument,
  IdentitySchema,
  ProvisioningState,
} from '../modules/identity/schemas/identity.schema';
import { IdentityProvisioningService } from '../modules/identity/identity-provisioning.service';
import { IdentityService } from '../modules/identity/identity.service';
import { BlueprintsService } from '../modules/blueprints/blueprints.service';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { AdClient } from '../modules/connectors/ad-connector/ad.client';
import { AccountNameService } from '../modules/connectors/ad-connector/account-name.service';
import { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import { SCIMClient } from '../modules/connectors/scim-connector/scim.client';
import { SCIMMapper } from '../modules/connectors/scim-connector/scim.mapper';
import { OktaService } from '../modules/connectors/okta-connector/okta.service';
import { GitHubService } from '../modules/connectors/github-connector/github.service';
import { ServiceNowService } from '../modules/connectors/servicenow-connector/servicenow.service';
import { PrivilegedAccessService } from '../modules/privileged-access/privileged-access.service';
import { EntraActivities } from './entra.activities';
import { AdActivities } from './ad.activities';
import { ScimActivities } from './scim.activities';
import { OktaActivities } from './okta.activities';
import { GitHubActivities } from './github.activities';
import { ServiceNowActivities } from './servicenow.activities';
import { EntitlementExpiryDeprovision } from './entitlement-expiry-deprovision';
import {
  EntitlementExpiryActivities,
  type EntitlementExpiryResult,
} from './entitlement-expiry.activities';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-22T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

/** The canvas: Entra ID, SCIM and AD connectors with a config. */
const AD_CONFIG = { host: 'ldap.a.example', baseDn: 'DC=a,DC=example' };
const BLUEPRINT = {
  nodes: [
    { id: 'entra-id', data: { type: 'entra-id', config: { tenantId: 'entra-tenant' } } },
    { id: 'scim', data: { type: 'scim', config: { baseUrl: 'https://scim.example' } } },
    { id: 'ad', data: { type: 'ad', config: AD_CONFIG } },
  ],
};
const SCIM_CONFIG = BLUEPRINT.nodes[1].data.config;

describe('Entitlement expiry deprovision and failures (MongoDB)', () => {
  let moduleRef: TestingModule;
  let activities: EntitlementExpiryActivities;
  let identities: Model<IdentityDocument>;
  const events = { emit: jest.fn() };
  const entra = { deleteUser: jest.fn(), getUserByEmail: jest.fn() };
  const adClient = { disableUser: jest.fn() };
  const scimClient = { patchUser: jest.fn(), deleteUser: jest.fn() };
  const okta = { offboardUser: jest.fn() };
  const github = { deprovision: jest.fn() };
  const serviceNow = { deprovision: jest.fn() };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        EntitlementExpiryActivities,
        EntitlementExpiryDeprovision,
        IdentityProvisioningService,
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
        { provide: BlueprintsService, useValue: { getLatestBlueprint: async () => BLUEPRINT } },
        // The per-target deprovision activities of offboarding and what they call
        EntraActivities,
        AdActivities,
        ScimActivities,
        OktaActivities,
        GitHubActivities,
        ServiceNowActivities,
        { provide: EntraService, useValue: entra },
        AdService,
        { provide: AdClient, useValue: adClient },
        SCIMService,
        { provide: SCIMClient, useValue: scimClient },
        { provide: SCIMMapper, useValue: {} },
        { provide: OktaService, useValue: okta },
        { provide: GitHubService, useValue: github },
        { provide: ServiceNowService, useValue: serviceNow },
        {
          provide: IdentityService,
          useValue: { findIdentityById: async () => null, endExpiredControls: async () => 0 },
        },
        { provide: AccountNameService, useValue: {} },
        { provide: EntitlementCatalogService, useValue: {} },
        { provide: CredentialGenerationService, useValue: {} },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: TenantService, useValue: { findAll: async () => [] } },
        {
          provide: PrivilegedAccessService,
          useValue: { deactivateExpiredSessions: async () => 0 },
        },
      ],
    }).compile();
    activities = moduleRef.get(EntitlementExpiryActivities);
    identities = moduleRef.get(getModelToken(Identity.name));
  });

  beforeEach(async () => {
    events.emit.mockReset();
    entra.deleteUser.mockReset().mockResolvedValue(true);
    entra.getUserByEmail.mockReset().mockResolvedValue(null);
    adClient.disableUser.mockReset().mockResolvedValue(undefined);
    scimClient.patchUser.mockReset().mockResolvedValue(undefined);
    okta.offboardUser.mockReset();
    github.deprovision.mockReset();
    serviceNow.deprovision.mockReset();
    await identities.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /** An identity with these provisioning entries and account ids (target name -> id). */
  async function identity(
    name: string,
    provisioning: Array<Record<string, unknown>>,
    accounts: Record<string, string> = {},
  ) {
    const doc = await withTenantContext(A, () =>
      identities.create({
        tenantId: A,
        profile: { firstName: name, lastName: 'Test', email: `${name}@a.example` },
        sources: Object.entries(accounts).map(([sourceName, externalId]) => ({
          sourceName,
          externalId,
          sourceRole: 'target',
        })),
        provisioning: provisioning.map((p) => ({ status: 'SYNCED', ...p })),
      }),
    );
    return String(doc._id);
  }

  async function entryOf(id: string, targetSystem: string): Promise<ProvisioningState> {
    const doc = await identities.findById(id).setOptions({ skipTenantScope: true }).lean().exec();
    const entry = doc?.provisioning.find((p) => p.targetSystem === targetSystem);
    if (!entry) throw new Error(`no ${targetSystem} entry on ${id}`);
    return entry;
  }

  /** The workflow's batches: until one neither deprovisions nor fails anything. */
  async function runWorkflow(now: Date, limit = 50) {
    const totals = { processed: 0, failed: 0, batches: 0 };
    let batch: EntitlementExpiryResult;
    do {
      batch = await activities.runEntitlementExpiryCheck(A, now.toISOString(), limit);
      totals.processed += batch.processed;
      totals.failed += batch.failed;
      totals.batches++;
      if (totals.batches > 10) throw new Error('the batches do not run out');
    } while (batch.processed > 0 || batch.failed > 0);
    return totals;
  }

  const emitted = (type: DomainEventType) =>
    events.emit.mock.calls.filter(([t]) => t === type).map(([, , payload]) => payload);

  const UNKNOWN_REASON =
    'salesforce: expiry has no deprovision for this target. Remove the access there by hand ' +
    'and mark it removed manually';

  it('entries that cannot be deprovisioned no longer block other identities', async () => {
    const unknown = { targetSystem: 'salesforce', expiresAt: at(-3 * DAY) };
    const stuck1 = await identity('ada', [unknown]);
    const stuck2 = await identity('bob', [unknown]);
    const other = await identity('cy', [{ targetSystem: 'scim', expiresAt: at(-HOUR) }], {
      scim: 'scim-3',
    });

    expect(await runWorkflow(NOW, 2)).toMatchObject({ processed: 1, failed: 2 });

    expect(scimClient.patchUser).toHaveBeenCalledTimes(1);
    expect(scimClient.patchUser).toHaveBeenCalledWith(SCIM_CONFIG, 'scim-3', expect.anything());
    expect((await entryOf(other, 'scim')).status).toBe('DEPROVISIONED');
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRED)).toEqual([
      expect.objectContaining({ identityId: other, targetSystem: 'scim' }),
    ]);

    for (const id of [stuck1, stuck2]) {
      const entry = await entryOf(id, 'salesforce');
      expect(entry.status).toBe('SYNCED');
      expect(entry.expiryFailure).toMatchObject({
        expiresAt: at(-3 * DAY),
        reason: UNKNOWN_REASON,
        retryable: false,
        attempts: 1,
      });
      expect(entry.expiryFailure?.nextAttemptAt).toBeUndefined();
    }
    const failures = emitted(DomainEventType.ENTITLEMENT_EXPIRY_FAILED);
    expect(failures.map((p) => p.identityId).sort()).toEqual([stuck1, stuck2].sort());
    for (const payload of failures) {
      expect(getEventSchema(DomainEventType.ENTITLEMENT_EXPIRY_FAILED).parse(payload)).toEqual({
        identityId: payload.identityId,
        targetSystem: 'salesforce',
        expiresAt: at(-3 * DAY).toISOString(),
        reason: UNKNOWN_REASON,
        retryable: false,
        attempts: 1,
      });
    }

    // Later runs leave them alone: nothing attempted, nothing emitted
    events.emit.mockClear();
    expect(await runWorkflow(at(HOUR), 2)).toEqual({ processed: 0, failed: 0, batches: 1 });
    expect(await runWorkflow(at(30 * DAY), 2)).toEqual({ processed: 0, failed: 0, batches: 1 });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('a retryable failure is tried again after 1 hour, then 2 hours, not on every run', async () => {
    const id = await identity('di', [{ targetSystem: 'scim', expiresAt: at(-HOUR) }], {
      scim: 'scim-4',
    });
    scimClient.patchUser
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValue(undefined);

    expect(await runWorkflow(NOW)).toEqual({ processed: 0, failed: 1, batches: 2 });
    expect(await entryOf(id, 'scim')).toMatchObject({
      status: 'SYNCED',
      expiryFailure: { retryable: true, attempts: 1, nextAttemptAt: at(HOUR) },
    });
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRY_FAILED)).toEqual([
      expect.objectContaining({
        identityId: id,
        retryable: true,
        attempts: 1,
        nextAttemptAt: at(HOUR).toISOString(),
        reason: 'scim: Request failed with status code 503',
      }),
    ]);

    await runWorkflow(at(30 * MINUTE));
    expect(scimClient.patchUser).toHaveBeenCalledTimes(1);

    await runWorkflow(at(HOUR));
    expect(scimClient.patchUser).toHaveBeenCalledTimes(2);
    expect((await entryOf(id, 'scim')).expiryFailure).toMatchObject({
      attempts: 2,
      nextAttemptAt: at(3 * HOUR),
    });

    await runWorkflow(at(2 * HOUR));
    expect(scimClient.patchUser).toHaveBeenCalledTimes(2);

    expect(await runWorkflow(at(3 * HOUR))).toMatchObject({ processed: 1, failed: 0 });
    expect(scimClient.patchUser).toHaveBeenCalledTimes(3);
    expect((await entryOf(id, 'scim')).status).toBe('DEPROVISIONED');
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRED)).toHaveLength(1);
    // Plan 2.0dn: no email, and nothing the schema would strip (the emitter parses with it)
    const [expired] = emitted(DomainEventType.ENTITLEMENT_EXPIRED);
    expect(getEventSchema(DomainEventType.ENTITLEMENT_EXPIRED).parse(expired)).toEqual(expired);
    expect(JSON.stringify(expired)).not.toContain('@a.example');
  });

  it('a client error is not retried until the expiry date changes', async () => {
    const id = await identity('ed', [{ targetSystem: 'scim', expiresAt: at(-HOUR) }], {
      scim: 'scim-5',
    });
    scimClient.patchUser.mockRejectedValueOnce(httpError(403)).mockResolvedValue(undefined);

    expect(await runWorkflow(NOW)).toMatchObject({ processed: 0, failed: 1 });
    expect((await entryOf(id, 'scim')).expiryFailure).toMatchObject({
      retryable: false,
      reason: 'scim: Request failed with status code 403 (HTTP 403)',
    });
    expect(await runWorkflow(at(2 * DAY))).toMatchObject({ processed: 0, failed: 0 });
    expect(scimClient.patchUser).toHaveBeenCalledTimes(1);

    // Granted again until tomorrow: the new expiry is acted on when it comes
    await identities
      .updateOne({ _id: id }, { $set: { 'provisioning.0.expiresAt': at(DAY) } })
      .setOptions({ skipTenantScope: true });
    expect(await runWorkflow(at(2 * DAY))).toMatchObject({ processed: 1, failed: 0 });
    expect((await entryOf(id, 'scim')).status).toBe('DEPROVISIONED');
  });

  it('removes Okta, GitHub and ServiceNow access through offboarding’s deprovision', async () => {
    const id = await identity(
      'fa',
      [
        { targetSystem: 'okta', expiresAt: at(-HOUR) },
        { targetSystem: 'github', expiresAt: at(-HOUR) },
        { targetSystem: 'servicenow', expiresAt: at(-HOUR) },
      ],
      { okta: '00u-fa', github: 'github-user-42', servicenow: 'snow-abc' },
    );
    okta.offboardUser.mockResolvedValue({ outcome: 'deprovisioned', detail: 'deactivated' });
    github.deprovision.mockResolvedValue({ outcome: 'deprovisioned', detail: 'removed' });
    serviceNow.deprovision.mockResolvedValue({ outcome: 'deprovisioned', detail: 'locked' });

    expect(await runWorkflow(NOW)).toMatchObject({ processed: 3, failed: 0 });

    expect(okta.offboardUser).toHaveBeenCalledWith({ oktaUserId: '00u-fa', login: 'fa@a.example' });
    expect(github.deprovision).toHaveBeenCalledWith('fa@a.example', undefined, { userId: 42 });
    expect(serviceNow.deprovision).toHaveBeenCalledWith({
      externalId: 'snow-abc',
      email: 'fa@a.example',
    });
    for (const system of ['okta', 'github', 'servicenow']) {
      const entry = await entryOf(id, system);
      expect(entry.status).toBe('DEPROVISIONED');
      expect(entry.expiryFailure).toBeUndefined();
    }
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRED)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetSystem: 'okta', outcome: 'deprovisioned' }),
        expect.objectContaining({ targetSystem: 'github', outcome: 'deprovisioned' }),
        expect.objectContaining({ targetSystem: 'servicenow', outcome: 'deprovisioned' }),
      ]),
    );
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRY_FAILED)).toEqual([]);
  });

  it('an account already gone counts as removed in every target', async () => {
    const id = await identity(
      'gu',
      [
        { targetSystem: 'entra-id', expiresAt: at(-HOUR) },
        { targetSystem: 'ad', expiresAt: at(-HOUR) },
        { targetSystem: 'scim', expiresAt: at(-HOUR) },
        { targetSystem: 'okta', expiresAt: at(-HOUR) },
      ],
      {
        'entra-id': 'entra-object-gu',
        ad: 'CN=Gu Test,OU=People,DC=a,DC=example',
        scim: 'scim-gu',
        okta: '00u-gu',
      },
    );
    entra.deleteUser.mockResolvedValue(false); // Graph 404 for the stored object id
    adClient.disableUser.mockRejectedValue(
      Object.assign(new Error('No Such Object'), { code: 32 }),
    );
    scimClient.patchUser.mockRejectedValue(new SCIMError(undefined, 'User not found', '404'));
    okta.offboardUser.mockResolvedValue({ outcome: 'already-gone', detail: 'no such user' });

    expect(await runWorkflow(NOW)).toMatchObject({ processed: 4, failed: 0 });

    expect(entra.deleteUser).toHaveBeenCalledWith(
      'entra-object-gu',
      BLUEPRINT.nodes[0].data.config,
    );
    expect(adClient.disableUser).toHaveBeenCalledWith(
      AD_CONFIG,
      'CN=Gu Test,OU=People,DC=a,DC=example',
    );
    for (const system of ['entra-id', 'ad', 'scim', 'okta']) {
      expect((await entryOf(id, system)).status).toBe('DEPROVISIONED');
    }
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRY_FAILED)).toEqual([]);
    expect(
      emitted(DomainEventType.ENTITLEMENT_EXPIRED).map((p) => [p.targetSystem, p.outcome]),
    ).toEqual(
      expect.arrayContaining([
        ['entra-id', 'already-gone'],
        ['ad', 'already-gone'],
        ['scim', 'already-gone'],
        ['okta', 'already-gone'],
      ]),
    );
  });

  it('a target that keeps no account has nothing to remove', async () => {
    const id = await identity('ha', [{ targetSystem: 'file-outbound', expiresAt: at(-HOUR) }]);

    expect(await runWorkflow(NOW)).toMatchObject({ processed: 1, failed: 0 });
    expect((await entryOf(id, 'file-outbound')).status).toBe('DEPROVISIONED');
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRED)).toEqual([
      expect.objectContaining({ targetSystem: 'file-outbound', outcome: 'not-applicable' }),
    ]);
  });

  it('records what a person must do when no account can be found to remove', async () => {
    const id = await identity('il', [
      { targetSystem: 'ad', expiresAt: at(-HOUR) },
      { targetSystem: 'entra-id', expiresAt: at(-HOUR) },
    ]);
    entra.deleteUser.mockResolvedValue(false); // Graph 404 for the email as UPN

    expect(await runWorkflow(NOW)).toMatchObject({ processed: 0, failed: 2 });
    expect(adClient.disableUser).not.toHaveBeenCalled();
    expect((await entryOf(id, 'ad')).expiryFailure).toMatchObject({
      retryable: false,
      reason:
        'ad: no AD distinguished name recorded for the account. Disable it in Active ' +
        'Directory by hand and mark it removed manually',
    });
    // No stored object id: a 404 for the email as UPN is no proof, and nobody has the email
    expect(entra.deleteUser).toHaveBeenCalledWith('il@a.example', BLUEPRINT.nodes[0].data.config);
    expect(entra.getUserByEmail).toHaveBeenCalledWith(
      'il@a.example',
      BLUEPRINT.nodes[0].data.config,
    );
    const entraEntry = await entryOf(id, 'entra-id');
    expect(entraEntry.status).toBe('SYNCED');
    expect(entraEntry.expiryFailure).toMatchObject({ retryable: false });
    expect(entraEntry.expiryFailure?.reason).toMatch(/^entra-id: No Entra ID user has the email/);
    expect(entraEntry.expiryFailure?.reason).not.toContain('il@a.example');
  });

  it('still warns once about access expiring next to a recorded failure', async () => {
    const id = await identity('hu', [
      { targetSystem: 'salesforce', expiresAt: at(-HOUR) },
      { targetSystem: 'entra-id', expiresAt: at(7 * DAY) },
    ]);

    await runWorkflow(NOW);
    await runWorkflow(at(HOUR));

    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRY_FAILED)).toHaveLength(1);
    expect(emitted(DomainEventType.ENTITLEMENT_EXPIRING_SOON)).toEqual([
      expect.objectContaining({ identityId: id, targetSystem: 'entra-id' }),
    ]);
    expect(entra.deleteUser).not.toHaveBeenCalled();
  });
});
