/**
 * Agents whose owner left (in-memory MongoDB). HX-G follow-up: nothing acted when an agent's
 * owner was offboarded, and after an erasure the agent kept an owner id that points nowhere, so an
 * ownerless agent could still be issued credentials. Decision: when the owner is offboarded or
 * erased, the owner's agents are marked ownerless, new credentials are refused for them, and an
 * audit entry and the nhi.owner_lost event ask a person to give each a new owner or revoke it.
 * Existing credentials keep working until then.
 *
 * Proves:
 *   - Offboarding the owner (IDENTITY_OFFBOARDING_COMPLETED) or deleting the identity marks the
 *     owner's agents that are not revoked, once, audited and signalled each; another owner's
 *     agents and revoked agents stay as they are.
 *   - A super-admin gives an ownerless agent a new, active owner: the mark goes, the change is
 *     audited and signalled. An owner who is not active, or a revoked agent, is refused.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import mongoose, { Model } from 'mongoose';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type { AuditService } from '../audit/audit.service';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { NhiService } from './nhi.service';
import { NhiOwnershipService } from './nhi-ownership.service';
import { NhiOwnerLeftHandler } from './nhi-owner-left.handler';
import {
  AgentIdentity,
  AgentIdentitySchema,
  type AgentIdentityDocument,
} from './schemas/agent-identity.schema';

const T = 'tenant-a';
const ADA = '64b7f0c2a1b2c3d4e5f60d01';
const BOB = '64b7f0c2a1b2c3d4e5f60d02';
const GRACE = '64b7f0c2a1b2c3d4e5f60d03';

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped test models */
describe('NHI agents whose owner left (in-memory MongoDB)', () => {
  let agents: Model<AgentIdentityDocument>;
  let identities: Model<any>;
  let ownership: NhiOwnershipService;
  let handler: NhiOwnerLeftHandler;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const events = { emit: jest.fn() };

  const agent = (agentId: string, owner: string, status = 'active') => ({
    tenantId: T,
    agentId,
    displayName: agentId,
    kind: 'workload',
    owner: { identityId: owner, email: `${owner}@corp.example` },
    scope: ['hr:read'],
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status,
    createdBy: 'admin@corp.example',
  });
  const stored = (agentId: string) => agents.findOne({ tenantId: T, agentId }).lean().exec();
  const event = (type: DomainEventType, identityId: string) =>
    ({ type, payload: { identityId }, metadata: { tenantId: T } }) as unknown as DomainEvent<any>;

  beforeAll(async () => {
    await connectTestDb();
    agents = mongoose.model(
      AgentIdentity.name,
      AgentIdentitySchema,
    ) as unknown as Model<AgentIdentityDocument>;
    identities = mongoose.model(Identity.name, IdentitySchema) as unknown as Model<any>;
    const nhi = new NhiService(
      agents,
      identities,
      audit as unknown as AuditService,
      events as unknown as DomainEventEmitterService,
    );
    ownership = new NhiOwnershipService(
      agents,
      nhi,
      audit as unknown as AuditService,
      events as unknown as DomainEventEmitterService,
    );
    handler = new NhiOwnerLeftHandler(ownership);
  });

  beforeEach(async () => {
    const person = (_id: string, firstName: string, status: string) => ({
      _id,
      tenantId: T,
      profile: { firstName, lastName: 'Test', email: `${firstName}@corp.example`, status },
    });
    await identities.create([
      person(ADA, 'ada', 'ACTIVE'),
      person(BOB, 'bob', 'ACTIVE'),
      person(GRACE, 'grace', 'SUSPENDED'),
    ]);
    await agents.create([
      agent('ada-sync', ADA),
      { ...agent('ada-old', ADA), status: 'expired' },
      { ...agent('ada-gone', ADA), status: 'revoked', revokedAt: new Date() },
      agent('bob-sync', BOB),
    ]);
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("marks the offboarded owner's agents ownerless once, audited and signalled each", async () => {
    await handler.onOffboardingCompleted(
      event(DomainEventType.IDENTITY_OFFBOARDING_COMPLETED, ADA),
    );
    // Offboarding also deletes the identity: the second signal changes nothing
    await handler.onIdentityDeleted(event(DomainEventType.IDENTITY_DELETED, ADA));

    for (const id of ['ada-sync', 'ada-old']) {
      expect(await stored(id)).toMatchObject({
        ownerlessReason: 'offboarded',
        ownerlessSince: expect.any(Date),
        owner: { identityId: ADA },
      });
    }
    expect((await stored('ada-gone'))?.ownerlessSince).toBeUndefined();
    expect((await stored('bob-sync'))?.ownerlessSince).toBeUndefined();
    expect(audit.log).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AGENT_IDENTITY_OWNERLESS',
        severity: 'warning',
        resourceId: 'ada-sync',
      }),
    );
    const lost = events.emit.mock.calls.filter(([t]) => t === DomainEventType.NHI_OWNER_LOST);
    expect(lost.map(([, , payload]) => payload)).toEqual(
      expect.arrayContaining([
        { agentId: 'ada-sync', ownerIdentityId: ADA, reason: 'offboarded' },
        { agentId: 'ada-old', ownerIdentityId: ADA, reason: 'offboarded' },
      ]),
    );
    expect(lost).toHaveLength(2);
  });

  it('gives an ownerless agent a new active owner, which ends the mark', async () => {
    await ownership.markOwnerless(T, ADA, 'offboarded');

    const after = await ownership.reown(T, 'ada-sync', BOB, 'sec@corp.example');

    expect(after.owner).toMatchObject({ identityId: BOB, email: 'bob@corp.example' });
    const doc = await stored('ada-sync');
    expect(doc?.ownerlessSince).toBeUndefined();
    expect(doc?.ownerlessReason).toBeUndefined();
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'AGENT_IDENTITY_OWNER_CHANGED',
        resourceId: 'ada-sync',
        payload: { metadata: expect.objectContaining({ previousOwnerIdentityId: ADA }) },
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.NHI_OWNER_CHANGED,
      'ada-sync',
      { agentId: 'ada-sync', previousOwnerIdentityId: ADA, ownerIdentityId: BOB },
      expect.objectContaining({ tenantId: T, actor: 'sec@corp.example' }),
    );
  });

  it('refuses an owner who is not active, and a revoked agent', async () => {
    await expect(ownership.reown(T, 'ada-sync', GRACE, 'sec@corp.example')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ownership.reown(T, 'ada-gone', BOB, 'sec@corp.example')).rejects.toThrow(
      ConflictException,
    );
    expect((await stored('ada-sync'))?.owner.identityId).toBe(ADA);
  });
});
