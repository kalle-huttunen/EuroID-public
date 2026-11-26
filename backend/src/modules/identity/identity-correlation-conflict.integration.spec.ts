/**
 * Correlation conflicts (in-memory MongoDB, real correlation, rule engine and review service): a
 * low-confidence match flags the identity it matched (metadata.correlationConflict,
 * requiresReview, conflictDetails with the minted identity's id) and mints an identity for the
 * incoming record. The flags live on a Mixed path and were never saved, so the conflict reached
 * neither GET /identity/conflicts nor the review flow.
 *
 * A record whose email an identity already has cannot get an identity of its own (the email is
 * unique per tenant): it is held on the conflict and merged from there. Minting it failed with a
 * duplicate key on every sync. A merge or link ends fully merged with the conflict closed, or
 * with nothing changed: the kept identity could take the incoming identity's email while that one
 * still held it, which failed after the sources were saved and left a half-merged identity.
 *
 * FOLLOWUPS 2026-11-25 (identity-uncorrelated.service.ts:279): Merge soft-deletes the incoming
 * identity and reports it with identity.deleted, as Link does, so the access graph, the audit log
 * and the timeline learn of it.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityUncorrelatedService } from './identity-uncorrelated.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { RowHeldForConflictReview } from './conflict-held-rows';
import { DeletedIdentityRowIgnored } from './deleted-identity-rows';
import { releasedEmail } from './identity-merge';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { CandidateSuggestionService } from './correlation/candidate-suggestion.service';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  withTestTenant,
  closeTestDb,
  testDbUri,
} from '@testing';

mongoose.plugin(tenantPlugin);

const HR = 'csv-hr';
const SECOND_HR = 'json-api-hr';
const EXISTING_EMAIL = 'ada@corp.example';
const INCOMING_EMAIL = 'grace@corp.example';

/** The same employee number in both HR sources, for two different people. */
const existingRow = {
  sourceSystem: HR,
  sourceUserId: `${HR}-1`,
  employeeNumber: 'E-100',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: EXISTING_EMAIL,
  status: UserStatus.ACTIVE,
} as StandardUserDto;
const incomingRow = {
  sourceSystem: SECOND_HR,
  sourceUserId: `${SECOND_HR}-1`,
  employeeNumber: 'E-100',
  firstName: 'Grace',
  lastName: 'Hopper',
  email: INCOMING_EMAIL,
  status: UserStatus.ACTIVE,
} as StandardUserDto;
/** The other person's record carrying the existing person's email. */
const sameEmailRow = { ...incomingRow, email: EXISTING_EMAIL } as StandardUserDto;
/** A third person, matching nobody. */
const thirdRow = {
  sourceSystem: HR,
  sourceUserId: `${HR}-3`,
  employeeNumber: 'E-300',
  firstName: 'Carol',
  lastName: 'Shaw',
  email: INCOMING_EMAIL,
  status: UserStatus.ACTIVE,
} as StandardUserDto;

/** A reconciliation config whose only rule: the second HR source owns the email. */
const emailOwnedBySecondHr = {
  hrSourceTags: [],
  sourcePriorityOrder: [],
  contractCriticalFields: [],
  defaultMastery: { email: [SECOND_HR] },
  targetIdKeys: [],
};

describe('Correlation conflicts of a low-confidence match (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let review: IdentityUncorrelatedService;
  let identityModel: Model<IdentityDocument>;
  const events = createMockEventEmitter();
  const reconConfig = {
    getConfig: jest.fn().mockResolvedValue(null),
    getHrSourceTags: jest.fn().mockResolvedValue([]),
  };
  // An employee number match scores 0.9: below this tenant's threshold, so it needs review
  const correlationConfig = {
    getCorrelationConfig: jest.fn().mockResolvedValue({
      rules: [{ strategy: 'employeeNumber' }],
      conflictAction: 'review',
      confidenceThreshold: 0.95,
    }),
    getPrimaryHrSourceName: jest.fn().mockResolvedValue(null),
    getHrPriorityConfig: jest.fn().mockResolvedValue(null),
    getHrPriorityFromBlueprint: jest.fn().mockResolvedValue(null),
    getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([]),
    getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
    isHrSourceName: jest.fn(async (name: string) => name === HR || name === SECOND_HR),
  };

  beforeAll(async () => {
    const { factory: loggerFactory } = createMockLoggerFactory();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
        ]),
      ],
      providers: [
        IdentityCorrelationService,
        IdentityUncorrelatedService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        ReconciliationService,
        CorrelationRuleEngine,
        CandidateSuggestionService,
        { provide: ReconciliationConfigService, useValue: reconConfig },
        { provide: CorrelationConfigService, useValue: correlationConfig },
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    review = moduleRef.get(IdentityUncorrelatedService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    await identityModel.syncIndexes(); // the unique email index the duplicates collide on
  });

  beforeEach(() => {
    events.emit.mockClear();
    reconConfig.getConfig.mockResolvedValue(null);
    correlationConfig.getPrimaryHrSourceName.mockResolvedValue(null);
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const storedMetadata = async (email: string) =>
    ((await identityModel.findOne({ 'profile.email': email }).lean().exec()) as unknown as Identity)
      .metadata;
  const stored = async (id: string) =>
    (await identityModel.findById(id).lean().exec()) as unknown as Identity;
  const sourceKeys = (identity: Identity) =>
    identity.sources.map((s) => `${s.sourceName}/${s.externalId}`);
  /** The identity.deleted events emitted, as [identity id, payload, options]. */
  const deletions = () =>
    events.emit.mock.calls
      .filter(([type]) => type === DomainEventType.IDENTITY_DELETED)
      .map(([, id, payload, options]) => [id, payload, options]);

  /** The existing person, then the other person's record that matches them with low confidence. */
  async function ingestConflict(): Promise<{ existingId: string; mintedId: string }> {
    const existing = await correlation.ensureIdentityFromUser({ ...existingRow });
    const minted = await correlation.ensureIdentityFromUser({ ...incomingRow });
    return { existingId: String(existing!._id), mintedId: String(minted!._id) };
  }

  it('stores the conflict flags on the matched identity', async () =>
    await withTestTenant(async () => {
      const { existingId, mintedId } = await ingestConflict();

      expect(mintedId).not.toBe(existingId);
      const metadata = await storedMetadata(EXISTING_EMAIL);
      expect(metadata?.correlationConflict).toBe(true);
      expect(metadata?.requiresReview).toBe(true);
      expect(metadata?.conflictDetails).toMatchObject({
        matchedBy: 'employeeNumber',
        matchedValue: 'E-100',
        confidence: 0.9,
        incomingIdentityId: mintedId,
        existingSnapshot: { email: EXISTING_EMAIL, firstName: 'Ada', lastName: 'Lovelace' },
        incomingSnapshot: {
          sourceName: SECOND_HR,
          email: INCOMING_EMAIL,
          firstName: 'Grace',
          lastName: 'Hopper',
        },
      });
      // The minted identity carries no conflict of its own: it waits in the uncorrelated queue
      const minted = await storedMetadata(INCOMING_EMAIL);
      expect(minted?.correlationStatus).toBe('uncorrelated');
      expect(minted?.requiresReview).toBeUndefined();
    }));

  it('keeps the minted identity of an open conflict when another low-confidence record arrives', async () =>
    await withTestTenant(async () => {
      const { existingId, mintedId } = await ingestConflict();

      // A third person with the same employee number, from a third source: minted, not linked
      const third = await correlation.ensureIdentityFromUser({
        ...thirdRow,
        sourceSystem: 'workday',
        sourceUserId: 'wd-3',
        employeeNumber: 'E-100',
        email: 'carol@corp.example',
      });

      expect(String(third!._id)).not.toBe(mintedId);
      const details = (await stored(existingId)).metadata?.conflictDetails;
      expect(details?.incomingIdentityId).toBe(mintedId);
      expect(details?.incomingSnapshot).toMatchObject({ email: INCOMING_EMAIL });
      expect((await stored(String(third!._id))).metadata?.correlationStatus).toBe('uncorrelated');
    }));

  it('lists the conflict in GET /identity/conflicts and the minted identity as uncorrelated', async () =>
    await withTestTenant(async () => {
      const { existingId, mintedId } = await ingestConflict();

      const conflicts = await review.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        _id: existingId,
        email: EXISTING_EMAIL,
        metadata: {
          requiresReview: true,
          correlationConflict: true,
          conflictDetails: { incomingIdentityId: mintedId },
        },
      });

      const uncorrelated = await review.getUncorrelated();
      expect(uncorrelated.map((identity) => identity._id)).toContain(mintedId);
    }));

  it('clears the stored conflict when a reviewer dismisses it', async () =>
    await withTestTenant(async () => {
      const { existingId } = await ingestConflict();

      await review.resolveConflict(existingId, 'dismiss');

      const metadata = await storedMetadata(EXISTING_EMAIL);
      expect(metadata?.correlationConflict).toBe(false);
      expect(metadata?.requiresReview).toBe(false);
      expect(metadata?.conflictDetails).toBeFalsy();
      expect(await review.getConflicts()).toHaveLength(0);
    }));

  it('takes an identity accepted as a new person out of the uncorrelated queue', async () =>
    await withTestTenant(async () => {
      const { mintedId } = await ingestConflict();

      await review.createStandalone(mintedId);

      expect((await storedMetadata(INCOMING_EMAIL))?.correlationStatus).toBe('correlated');
      const queue = await review.getUncorrelated();
      expect(queue.map((identity) => identity._id)).not.toContain(mintedId);
    }));

  describe('merge', () => {
    it('merges an incoming identity whose email the merge gives the kept identity', async () =>
      await withTestTenant(async () => {
        reconConfig.getConfig.mockResolvedValue(emailOwnedBySecondHr);
        const { existingId, mintedId } = await ingestConflict();

        await review.resolveConflict(existingId, 'merge');

        const kept = await stored(existingId);
        expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`, `${SECOND_HR}/${SECOND_HR}-1`]);
        expect(kept.profile.email).toBe(INCOMING_EMAIL); // the email's owner is the second HR
        expect(kept.metadata?.requiresReview).toBe(false);
        expect(kept.metadata?.conflictDetails).toBeFalsy();
        const merged = await stored(mintedId);
        expect(merged.deletedAt).toBeTruthy();
        expect(merged.deletedBy).toBe('merge-resolution');
        expect(merged.profile.email).not.toBe(INCOMING_EMAIL); // released for the kept identity
        expect(await review.getConflicts()).toHaveLength(0);
      }));

    it('reports the incoming identity deleted, as Link does', async () =>
      await withTestTenant(async () => {
        const { existingId, mintedId } = await ingestConflict();
        events.emit.mockClear();

        await review.resolveConflict(existingId, 'merge');

        expect(deletions()).toEqual([
          [
            mintedId,
            { identityId: mintedId, reason: 'merged-into-target' },
            { actor: 'merge-resolution' },
          ],
        ]);
      }));

    it('keeps the primary HR source values of the kept identity when no source masters them', async () =>
      await withTestTenant(async () => {
        correlationConfig.getPrimaryHrSourceName.mockResolvedValue(HR);
        const { existingId } = await ingestConflict();

        await review.resolveConflict(existingId, 'merge');

        const kept = await stored(existingId);
        expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`, `${SECOND_HR}/${SECOND_HR}-1`]);
        // The secondary HR source supplements: it does not replace what the primary carries
        expect(kept.profile.email).toBe(EXISTING_EMAIL);
        expect(kept.profile.firstName).toBe('Ada');
      }));

    it('changes nothing and answers 409 when the merged email belongs to a third identity', async () =>
      await withTestTenant(async () => {
        reconConfig.getConfig.mockResolvedValue(emailOwnedBySecondHr);
        const { existingId, mintedId } = await ingestConflict();
        // The incoming identity's email changed since; a third person has its HR record's email
        await identityModel.updateOne(
          { _id: mintedId },
          { $set: { 'profile.email': 'grace.hopper@corp.example' } },
        );
        await correlation.ensureIdentityFromUser({ ...thirdRow });

        const merge = review.resolveConflict(existingId, 'merge');
        await expect(merge).rejects.toBeInstanceOf(ConflictException);
        await expect(merge).rejects.toThrow('another identity already has (email)');

        const kept = await stored(existingId);
        expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`]);
        expect(kept.profile.email).toBe(EXISTING_EMAIL);
        expect(kept.metadata).toMatchObject({
          requiresReview: true,
          conflictDetails: { incomingIdentityId: mintedId },
        });
        const incoming = await stored(mintedId);
        expect(incoming.deletedAt).toBeFalsy();
        expect(incoming.profile.email).toBe('grace.hopper@corp.example');
        expect(deletions()).toEqual([]);
      }));

    // A soft-deleted incoming identity used to answer this too; one that offboarding deleted is
    // now merged (below), so the case left is an identity that another merge took
    it('changes nothing and answers 409 when the incoming identity was merged away', async () =>
      await withTestTenant(async () => {
        const { existingId, mintedId } = await ingestConflict();
        await identityModel.updateOne(
          { _id: mintedId },
          { $set: { deletedAt: new Date(), 'profile.email': releasedEmail(mintedId) } },
        );

        const merge = review.resolveConflict(existingId, 'merge');
        await expect(merge).rejects.toBeInstanceOf(ConflictException);
        await expect(merge).rejects.toThrow('no longer exists');

        expect((await storedMetadata(EXISTING_EMAIL))?.requiresReview).toBe(true);
      }));

    /** Accounts of the identity in targets: an Entra ID account written back, a file target. */
    const accounts = (id: string, entra: Record<string, unknown>) =>
      identityModel.updateOne(
        { _id: id },
        {
          $set: {
            provisioning: [
              { targetSystem: 'entra-id', writebackComplete: true, ...entra },
              { targetSystem: 'file-outbound', status: 'SYNCED', provisionedAt: new Date() },
            ],
          },
          $push: {
            sources: {
              sourceName: 'entra-id',
              externalId: `obj-${id}`,
              sourceRole: 'target',
              rawData: { email: `account-${id}@corp.example` },
            },
          },
        },
      );

    it.each([
      ['merge', (keptId: string) => review.resolveConflict(keptId, 'merge')],
      ['link', (keptId: string, id: string) => review.linkUncorrelatedToTarget(id, keptId, 'a@b')],
    ])(
      'refuses a %s with 409 and changes nothing while the incoming identity has an account',
      async (_action, merge) =>
        await withTestTenant(async () => {
          const { existingId, mintedId } = await ingestConflict();
          // Onboarded as a joiner: an Entra ID account (the mover's rule: provisioned, not
          // deprovisioned since), and a file target, which keeps no account
          await accounts(mintedId, { status: 'ERROR', provisionedAt: new Date() });

          const refused = merge(existingId, mintedId);
          await expect(refused).rejects.toBeInstanceOf(ConflictException);
          await expect(refused).rejects.toThrow(
            `Identity ${mintedId} still has an account in entra-id, so nothing was changed`,
          );

          const kept = await stored(existingId);
          expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`]);
          expect(kept.metadata?.requiresReview).toBe(true);
          const incoming = await stored(mintedId);
          expect(incoming.deletedAt).toBeFalsy();
          expect(incoming.profile.email).toBe(INCOMING_EMAIL);
        }),
    );

    it('merges once offboarding removed the incoming identity accounts, leaving their links', async () =>
      await withTestTenant(async () => {
        // The Entra ID account owns the email
        reconConfig.getConfig.mockResolvedValue({
          ...emailOwnedBySecondHr,
          defaultMastery: { email: ['entra-id'] },
        });
        const { existingId, mintedId } = await ingestConflict();
        await accounts(existingId, { status: 'SYNCED', provisionedAt: new Date() });
        await correlation.ensureIdentityFromUser({ ...existingRow }); // reconciles the kept one
        const keptEmail = `account-${existingId}@corp.example`;
        expect((await stored(existingId)).profile.email).toBe(keptEmail);
        // Offboarding deprovisioned the Entra ID account (a file target stays SYNCED) and
        // soft-deleted the identity
        const offboardedAt = new Date('2026-11-20T10:00:00Z');
        await accounts(mintedId, { status: 'DEPROVISIONED', provisionedAt: null });
        await identityModel.updateOne(
          { _id: mintedId },
          { $set: { deletedAt: offboardedAt, deletedBy: 'offboarding-workflow' } },
        );

        await review.resolveConflict(existingId, 'merge');

        const kept = await stored(existingId);
        // The HR record joins; the link to the removed account does not
        expect(sourceKeys(kept)).toEqual([
          `${HR}/${HR}-1`,
          `entra-id/obj-${existingId}`,
          `${SECOND_HR}/${SECOND_HR}-1`,
        ]);
        expect(kept.profile.email).toBe(keptEmail);
        expect(kept.metadata?.requiresReview).toBe(false);
        const merged = await stored(mintedId);
        expect(merged.deletedAt).toEqual(offboardedAt);
        expect(merged.deletedBy).toBe('offboarding-workflow');
        expect(merged.profile.email).toBe(releasedEmail(mintedId));
        // Its offboarding reported the deletion then
        expect(deletions()).toEqual([]);
      }));

    it('links an uncorrelated identity whose email the target takes, closing its conflict', async () =>
      await withTestTenant(async () => {
        reconConfig.getConfig.mockResolvedValue(emailOwnedBySecondHr);
        const { existingId, mintedId } = await ingestConflict();

        await review.linkUncorrelatedToTarget(mintedId, existingId, 'admin@corp.example');

        const kept = await stored(existingId);
        expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`, `${SECOND_HR}/${SECOND_HR}-1`]);
        expect(kept.profile.email).toBe(INCOMING_EMAIL);
        expect(kept.metadata?.correlationStatus).toBe('correlated');
        expect(kept.metadata?.requiresReview).toBe(false);
        const linked = await stored(mintedId);
        expect(linked.deletedAt).toBeTruthy();
        expect(linked.profile.email).not.toBe(INCOMING_EMAIL);
        expect(await review.getConflicts()).toHaveLength(0);
        const queue = await review.getUncorrelated();
        expect(queue.map((identity) => identity._id)).not.toContain(mintedId);
      }));

    /**
     * Link refuses an uncorrelated identity with an account, so the admin deletes it first. It
     * then left the queue for good: its HR record stayed on the deleted identity, ignored at
     * every sync, unless another identity's conflict named it.
     */
    describe('an uncorrelated identity offboarded before its link', () => {
      const offboardedAt = new Date('2026-11-20T10:00:00Z');
      /** Delete offboarded it: the Entra ID account deprovisioned, the identity soft-deleted. */
      const offboard = async (id: string) => {
        await accounts(id, { status: 'DEPROVISIONED', provisionedAt: null });
        await identityModel.updateOne(
          { _id: id },
          { $set: { deletedAt: offboardedAt, deletedBy: 'offboarding-workflow' } },
        );
      };
      const queued = async () =>
        (await review.getUncorrelated()).map((identity) => [identity._id, identity.offboarded]);

      it('stays in the queue, offboarded and ready to link, and links there', async () =>
        await withTestTenant(async () => {
          const { existingId, mintedId } = await ingestConflict();
          await offboard(mintedId);
          // Its HR record changes nothing while it sits on the deleted identity
          await expect(
            correlation.ensureIdentityFromUser({ ...incomingRow }),
          ).rejects.toBeInstanceOf(DeletedIdentityRowIgnored);

          expect(await queued()).toEqual(
            expect.arrayContaining([
              [existingId, false],
              [mintedId, true],
            ]),
          );
          expect(await review.countUncorrelated()).toBe(2);

          await review.linkUncorrelatedToTarget(mintedId, existingId, 'admin@corp.example');

          const kept = await stored(existingId);
          expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`, `${SECOND_HR}/${SECOND_HR}-1`]);
          expect(kept.metadata?.correlationStatus).toBe('correlated');
          expect(kept.metadata?.requiresReview).toBe(false);
          const linked = await stored(mintedId);
          expect(linked.deletedAt).toEqual(offboardedAt);
          expect(linked.deletedBy).toBe('offboarding-workflow');
          expect(linked.profile.email).toBe(releasedEmail(mintedId));
          expect(await queued()).toEqual([]);
          expect(await review.countUncorrelated()).toBe(0);
          // Merged away: nothing left to link or keep separate
          expect(await review.linkUncorrelatedToTarget(mintedId, existingId, 'a@b')).toBeNull();
          expect(await review.createStandalone(mintedId)).toBeNull();
          // The record's next sync updates the identity it joined
          const next = await correlation.ensureIdentityFromUser({ ...incomingRow });
          expect(String(next!._id)).toBe(existingId);
        }));

      it('leaves the queue, still deleted, when kept separate', async () =>
        await withTestTenant(async () => {
          const { mintedId } = await ingestConflict();
          await offboard(mintedId);

          await review.createStandalone(mintedId);

          expect((await queued()).map(([id]) => id)).not.toContain(mintedId);
          const kept = await stored(mintedId);
          expect(kept.metadata?.correlationStatus).toBe('correlated');
          expect(kept.deletedAt).toEqual(offboardedAt);
          expect(kept.profile.email).toBe(INCOMING_EMAIL);
        }));

      it('is not listed while deleted with an account left, and its link keeps the 409', async () =>
        await withTestTenant(async () => {
          const { existingId, mintedId } = await ingestConflict();
          await accounts(mintedId, { status: 'SYNCED', provisionedAt: new Date() });
          await identityModel.updateOne(
            { _id: mintedId },
            { $set: { deletedAt: offboardedAt, deletedBy: 'admin@corp.example' } },
          );

          expect((await queued()).map(([id]) => id)).not.toContain(mintedId);
          const link = review.linkUncorrelatedToTarget(mintedId, existingId, 'admin@corp.example');
          await expect(link).rejects.toBeInstanceOf(ConflictException);
          await expect(link).rejects.toThrow(
            `Identity ${mintedId} still has an account in entra-id, so nothing was changed`,
          );
          expect(sourceKeys(await stored(existingId))).toEqual([`${HR}/${HR}-1`]);
          expect((await stored(mintedId)).profile.email).toBe(INCOMING_EMAIL);
        }));
    });
  });

  // Hunt 2026-11-25 02 F16: a sync replaced the first entry of its source name, so after a merge
  // of two records of one source the other record was overwritten and then deduplicated away
  describe('an identity holding two records of one source (after a merge)', () => {
    async function mergedIdentity(): Promise<string> {
      const kept = await correlation.ensureIdentityFromUser({ ...existingRow });
      await identityModel.updateOne(
        { _id: kept!._id },
        {
          $push: {
            sources: {
              sourceName: HR,
              externalId: `${HR}-2`,
              rawData: { ...existingRow, sourceUserId: `${HR}-2`, jobTitle: 'Analyst' },
              sourceRole: 'primary-hr',
            },
          },
        },
      );
      return String(kept!._id);
    }

    it('updates the record the sync names and keeps the other', async () =>
      await withTestTenant(async () => {
        const id = await mergedIdentity();

        await correlation.ensureIdentityFromUser({
          ...existingRow,
          sourceUserId: `${HR}-2`,
          jobTitle: 'Lead Analyst',
        });
        await correlation.pushSourceAndReconcile(id, HR, `${HR}-2`, { jobTitle: 'Principal' });

        const kept = await stored(id);
        expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`, `${HR}/${HR}-2`]);
        expect(kept.sources[0].rawData).not.toHaveProperty('jobTitle', 'Principal');
        expect(kept.sources[1].rawData).toMatchObject({ jobTitle: 'Principal' });
      }));

    it('still replaces the one record of a source whose key changed', async () =>
      await withTestTenant(async () => {
        const kept = await correlation.ensureIdentityFromUser({ ...existingRow });
        // The same person, re-keyed in HR: found by the email rule, not by the old source key
        correlationConfig.getCorrelationConfig.mockResolvedValueOnce({
          rules: [{ strategy: 'email' }],
          conflictAction: 'review',
          confidenceThreshold: 0.7,
        });
        await correlation.ensureIdentityFromUser({ ...existingRow, sourceUserId: `${HR}-NEW` });

        expect(sourceKeys(await stored(String(kept!._id)))).toEqual([`${HR}/${HR}-NEW`]);
      }));
  });

  describe('a record with an email an identity already has', () => {
    /** The existing person, then the other person's record with the existing person's email. */
    async function ingestHeld(): Promise<string> {
      const existing = await correlation.ensureIdentityFromUser({ ...existingRow });
      await expect(correlation.ensureIdentityFromUser({ ...sameEmailRow })).rejects.toBeInstanceOf(
        RowHeldForConflictReview,
      );
      return String(existing!._id);
    }

    it('is held on the conflict instead of minting a second identity, sync after sync', async () =>
      await withTestTenant(async () => {
        await ingestHeld();
        // The next sync of the row holds it again: no duplicate key error
        await expect(
          correlation.ensureIdentityFromUser({ ...sameEmailRow }),
        ).rejects.toBeInstanceOf(RowHeldForConflictReview);

        expect(await identityModel.countDocuments({})).toBe(1);
        const metadata = await storedMetadata(EXISTING_EMAIL);
        expect(metadata).toMatchObject({
          correlationConflict: true,
          requiresReview: true,
          conflictDetails: {
            matchedBy: 'employeeNumber',
            incomingSnapshot: { sourceName: SECOND_HR, firstName: 'Grace', email: EXISTING_EMAIL },
            incomingSource: {
              sourceName: SECOND_HR,
              externalId: `${SECOND_HR}-1`,
              rawData: { firstName: 'Grace', lastName: 'Hopper', email: EXISTING_EMAIL },
            },
          },
        });
        expect(metadata?.conflictDetails?.incomingIdentityId).toBeUndefined();
      }));

    // Hunt 2026-11-25 02 F15: a second record replaced the open conflict, the first held record
    // was lost until its next sync, the two then alternated, and every sync emitted again
    it('keeps an open conflict when another record is held, and reports each conflict once', async () =>
      await withTestTenant(async () => {
        await ingestHeld();
        const conflicts = () =>
          events.emit.mock.calls.filter(([type]) => type === DomainEventType.CORRELATION_CONFLICT);
        expect(conflicts()).toHaveLength(1);

        // A third person's record with the same email, from another source
        await expect(
          correlation.ensureIdentityFromUser({
            ...thirdRow,
            sourceSystem: 'workday',
            sourceUserId: 'wd-3',
            email: EXISTING_EMAIL,
          }),
        ).rejects.toBeInstanceOf(RowHeldForConflictReview);
        // The first held record syncs again, with a changed title
        await expect(
          correlation.ensureIdentityFromUser({ ...sameEmailRow, jobTitle: 'Admiral' }),
        ).rejects.toBeInstanceOf(RowHeldForConflictReview);

        const details = (await storedMetadata(EXISTING_EMAIL))?.conflictDetails;
        expect(details?.incomingSource).toMatchObject({
          sourceName: SECOND_HR,
          externalId: `${SECOND_HR}-1`,
          rawData: { jobTitle: 'Admiral' },
        });
        expect(details?.incomingSnapshot).toMatchObject({ jobTitle: 'Admiral' });
        expect(conflicts()).toHaveLength(1);
      }));

    it('is merged into the identity under review, whose record its next sync then updates', async () =>
      await withTestTenant(async () => {
        const existingId = await ingestHeld();

        await review.resolveConflict(existingId, 'merge');

        const kept = await stored(existingId);
        expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`, `${SECOND_HR}/${SECOND_HR}-1`]);
        expect(kept.metadata?.requiresReview).toBe(false);
        expect(kept.metadata?.conflictDetails).toBeFalsy();
        const next = await correlation.ensureIdentityFromUser({ ...sameEmailRow });
        expect(String(next!._id)).toBe(existingId);
        expect(await identityModel.countDocuments({})).toBe(1);
      }));

    it('is not merged when a later sync gave its record to another identity', async () =>
      await withTestTenant(async () => {
        const existingId = await ingestHeld();
        const other = await correlation.ensureIdentityFromUser({
          ...thirdRow,
          email: 'carol@corp.example',
        });
        await identityModel.updateOne(
          { _id: other!._id },
          { $push: { sources: { sourceName: SECOND_HR, externalId: `${SECOND_HR}-1` } } },
        );

        const merge = review.resolveConflict(existingId, 'merge');
        await expect(merge).rejects.toBeInstanceOf(ConflictException);
        await expect(merge).rejects.toThrow(`now belongs to identity ${String(other!._id)}`);

        const kept = await stored(existingId);
        expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`]);
        expect(kept.metadata?.requiresReview).toBe(true);
      }));

    it('cannot be split off, since it cannot become an identity of its own', async () =>
      await withTestTenant(async () => {
        const existingId = await ingestHeld();

        const split = review.resolveConflict(existingId, 'split');
        await expect(split).rejects.toBeInstanceOf(ConflictException);
        await expect(split).rejects.toThrow('cannot become an identity of its own');

        expect((await storedMetadata(EXISTING_EMAIL))?.requiresReview).toBe(true);
      }));
  });

  describe('a record no rule matches, with an email an identity already has', () => {
    /** Another employee number than the existing person's, so the only rule matches nobody. */
    const unmatchedRow = {
      ...sameEmailRow,
      sourceUserId: `${SECOND_HR}-2`,
      employeeNumber: 'E-200',
    } as StandardUserDto;

    /** The existing person, then the unmatched record; returns the existing identity's id. */
    async function ingestUnmatched(): Promise<string> {
      const existing = await correlation.ensureIdentityFromUser({ ...existingRow });
      await expect(correlation.ensureIdentityFromUser({ ...unmatchedRow })).rejects.toBeInstanceOf(
        RowHeldForConflictReview,
      );
      return String(existing!._id);
    }

    it('is held on the identity with that email, sync after sync, instead of failing', async () =>
      await withTestTenant(async () => {
        const existingId = await ingestUnmatched();
        // The next sync holds it again: no duplicate key error on the unique email
        await expect(
          correlation.ensureIdentityFromUser({ ...unmatchedRow }),
        ).rejects.toBeInstanceOf(RowHeldForConflictReview);

        expect(await identityModel.countDocuments({})).toBe(1);
        const metadata = await storedMetadata(EXISTING_EMAIL);
        expect(metadata).toMatchObject({
          correlationConflict: true,
          requiresReview: true,
          conflictDetails: {
            matchedBy: 'email',
            matchedValue: EXISTING_EMAIL,
            confidence: 0,
            existingSnapshot: { email: EXISTING_EMAIL, firstName: 'Ada' },
            incomingSnapshot: { sourceName: SECOND_HR, firstName: 'Grace', email: EXISTING_EMAIL },
            incomingSource: {
              sourceName: SECOND_HR,
              externalId: `${SECOND_HR}-2`,
              rawData: { firstName: 'Grace', employeeNumber: 'E-200', email: EXISTING_EMAIL },
            },
          },
        });
        expect(metadata?.conflictDetails?.incomingIdentityId).toBeUndefined();
        // It is in the conflict queue
        const conflicts = await review.getConflicts();
        expect(conflicts.map((c) => c._id)).toEqual([existingId]);
      }));

    it('is merged into that identity, whose record its next sync then updates', async () =>
      await withTestTenant(async () => {
        const existingId = await ingestUnmatched();

        await review.resolveConflict(existingId, 'merge');

        const kept = await stored(existingId);
        expect(sourceKeys(kept)).toEqual([`${HR}/${HR}-1`, `${SECOND_HR}/${SECOND_HR}-2`]);
        expect(kept.metadata?.requiresReview).toBe(false);
        const next = await correlation.ensureIdentityFromUser({ ...unmatchedRow });
        expect(String(next!._id)).toBe(existingId);
        expect(await identityModel.countDocuments({})).toBe(1);
      }));
  });
});
