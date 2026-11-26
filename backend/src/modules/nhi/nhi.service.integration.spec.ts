/**
 * The NHI kill switch on in-memory MongoDB: it reaches every active agent delegated from the
 * agent, at any depth, in the agent's tenant. A delegated agent the switch leaves active could
 * still act on the scope it was given. On an agent already revoked it is still engaged, flagged,
 * audited and signalled. Its dry run lists exactly the agents the real call then reaches and
 * changes nothing, and a delegated agent is stored with its parent in the same write, so no
 * failure can leave it outside the cascade.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import mongoose, { Model } from 'mongoose';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { AuditService } from '../audit/audit.service';
import { NhiService } from './nhi.service';
import {
  AgentIdentity,
  AgentIdentitySchema,
  type AgentIdentityDocument,
} from './schemas/agent-identity.schema';

describe('NhiService kill switch cascade (in-memory MongoDB)', () => {
  let agents: Model<AgentIdentityDocument>;
  let service: NhiService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const events = { emit: jest.fn() };
  const EARLIER = new Date('2026-11-01T10:00:00.000Z');

  const agent = (tenantId: string, agentId: string, parentAgentId?: string) => ({
    tenantId,
    agentId,
    displayName: agentId,
    kind: 'ai-agent',
    owner: { identityId: 'owner-1', email: 'owner@example.test' },
    scope: ['hr:read'],
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status: 'active',
    createdBy: 'admin@example.test',
    ...(parentAgentId ? { parentAgentId } : {}),
  });
  const stored = (tenantId: string, agentId: string) =>
    agents.findOne({ tenantId, agentId }).lean().exec();

  beforeAll(async () => {
    await connectTestDb();
    agents = mongoose.model(
      AgentIdentity.name,
      AgentIdentitySchema,
    ) as unknown as Model<AgentIdentityDocument>;
    service = new NhiService(
      agents,
      undefined as never, // revoke reads no identity
      audit as unknown as AuditService,
      events as unknown as DomainEventEmitterService,
    );
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('revokes and kills both active delegated agents and their own delegate, nothing else', async () => {
    await agents.create([
      agent('t', 'parent-bot'),
      agent('t', 'child-1', 'parent-bot'),
      agent('t', 'child-2', 'parent-bot'),
      agent('t', 'grandchild-1', 'child-1'),
      {
        ...agent('t', 'child-old', 'parent-bot'),
        status: 'revoked',
        revokedAt: EARLIER,
        revokedBy: 'old@example.test',
        revocationReason: 'earlier',
      },
      // Another tenant's agent naming the same parent id
      agent('u', 'child-x', 'parent-bot'),
    ]);

    await service.revoke('t', 'parent-bot', {
      reason: 'compromised',
      actor: 'sec@example.test',
      killSwitch: true,
    });

    expect(await stored('t', 'parent-bot')).toMatchObject({
      status: 'revoked',
      killSwitchEngaged: true,
      revokedBy: 'sec@example.test',
      revocationReason: 'compromised',
    });
    for (const agentId of ['child-1', 'child-2']) {
      expect(await stored('t', agentId)).toMatchObject({
        status: 'revoked',
        killSwitchEngaged: true,
        revokedBy: 'sec@example.test',
        revocationReason: 'cascade: compromised',
      });
    }
    expect(await stored('t', 'grandchild-1')).toMatchObject({
      status: 'revoked',
      killSwitchEngaged: true,
    });
    // An earlier revocation stays as it was; another tenant's agent is not reached
    expect(await stored('t', 'child-old')).toMatchObject({
      status: 'revoked',
      revokedAt: EARLIER,
      revokedBy: 'old@example.test',
      revocationReason: 'earlier',
    });
    expect(await stored('u', 'child-x')).toMatchObject({ status: 'active' });

    const killed = events.emit.mock.calls
      .filter(([type]) => type === DomainEventType.NHI_KILL_SWITCH_ENGAGED)
      .map(([, agentId, payload]) => [agentId, payload.killSwitch]);
    expect(killed.sort()).toEqual([
      ['child-1', true],
      ['child-2', true],
      ['grandchild-1', true],
      ['parent-bot', true],
    ]);
    expect(events.emit).toHaveBeenCalledTimes(4);
    const entries = audit.log.mock.calls.map(([entry]) => [entry.resourceId, entry.action]);
    expect(entries.sort()).toEqual([
      ['child-1', 'AGENT_IDENTITY_KILL_SWITCH'],
      ['child-2', 'AGENT_IDENTITY_KILL_SWITCH'],
      ['grandchild-1', 'AGENT_IDENTITY_KILL_SWITCH'],
      ['parent-bot', 'AGENT_IDENTITY_KILL_SWITCH'],
    ]);
  });

  // It answered 200 and changed nothing: no flag, no critical audit entry, no kill signal
  it('engages the kill switch on an agent already revoked, keeping the revocation', async () => {
    await agents.create({
      ...agent('t', 'retired-bot'),
      status: 'revoked',
      revokedAt: EARLIER,
      revokedBy: 'old@example.test',
      revocationReason: 'retired',
    });

    const killed = await service.revoke('t', 'retired-bot', {
      reason: 'leaked key',
      actor: 'sec@example.test',
      killSwitch: true,
    });

    expect(killed.killSwitchEngaged).toBe(true);
    expect(await stored('t', 'retired-bot')).toMatchObject({
      status: 'revoked',
      killSwitchEngaged: true,
      revokedAt: EARLIER,
      revokedBy: 'old@example.test',
      revocationReason: 'retired',
    });
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.NHI_KILL_SWITCH_ENGAGED,
      'retired-bot',
      { agentId: 'retired-bot', reason: 'leaked key', killSwitch: true },
      { tenantId: 't', actor: 'sec@example.test' },
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AGENT_IDENTITY_KILL_SWITCH',
        severity: 'critical',
        actor: 'sec@example.test',
        resourceId: 'retired-bot',
      }),
    );

    // Engaged once: another kill switch or a revoke reports nothing
    jest.clearAllMocks();
    const again = { reason: 'again', actor: 'sec@example.test' };
    await service.revoke('t', 'retired-bot', { ...again, killSwitch: true });
    await service.revoke('t', 'retired-bot', again);
    expect(events.emit).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  describe('dry run', () => {
    const ids = (rows: Array<{ agentId: string }>) => rows.map((r) => r.agentId).sort();
    const everything = () => agents.find({}).sort({ tenantId: 1, agentId: 1 }).lean().exec();

    // The page built its preview in the browser from GET /nhi?status=active, capped at 2000
    it('lists exactly the agents the kill switch then reaches, and changes nothing', async () => {
      await agents.create([
        agent('t', 'parent-bot'),
        agent('t', 'child-1', 'parent-bot'),
        agent('t', 'child-2', 'parent-bot'),
        agent('t', 'grandchild-1', 'child-1'),
        // Stored as active past its expiry: the real call reaches it, so the preview lists it
        { ...agent('t', 'stale-child', 'parent-bot'), expiresAt: EARLIER },
        { ...agent('t', 'child-old', 'parent-bot'), status: 'revoked', revokedAt: EARLIER },
        agent('u', 'child-x', 'parent-bot'),
      ]);
      const before = await everything();

      const preview = await service.previewRevoke('t', 'parent-bot', true);

      expect(preview).toMatchObject({
        dryRun: true,
        agentId: 'parent-bot',
        killSwitch: true,
        changes: true,
      });
      expect(ids(preview.reached)).toEqual(['child-1', 'child-2', 'grandchild-1', 'stale-child']);
      expect(preview.reached.find((a) => a.agentId === 'grandchild-1')).toMatchObject({
        displayName: 'grandchild-1',
        kind: 'ai-agent',
        parentAgentId: 'child-1',
        owner: { identityId: 'owner-1', email: 'owner@example.test' },
        status: 'active',
      });
      expect(await everything()).toEqual(before);
      expect(audit.log).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();

      await service.revoke('t', 'parent-bot', {
        reason: 'compromised',
        actor: 'sec@example.test',
        killSwitch: true,
      });
      const killed = await agents.find({ tenantId: 't', killSwitchEngaged: true }).lean().exec();
      expect(ids(killed.filter((a) => a.agentId !== 'parent-bot'))).toEqual(ids(preview.reached));
      // Each level of the cascade prefixes the reason, as before the dry run existed
      expect(await stored('t', 'grandchild-1')).toMatchObject({
        revocationReason: 'cascade: cascade: compromised',
      });
    });

    it('answers what a call on a revoked or killed agent would change', async () => {
      await agents.create([
        { ...agent('t', 'retired-bot'), status: 'revoked', revokedAt: EARLIER },
        agent('t', 'retired-child', 'retired-bot'),
        { ...agent('t', 'killed-bot'), status: 'revoked', killSwitchEngaged: true },
      ]);

      // A revoke of a revoked agent still reaches a delegated agent left active (a revoke that
      // failed part way through its cascade), and so does its kill switch
      const revoke = await service.previewRevoke('t', 'retired-bot', false);
      expect(revoke).toMatchObject({ dryRun: true, killSwitch: false, changes: true });
      expect(ids(revoke.reached)).toEqual(['retired-child']);
      const kill = await service.previewRevoke('t', 'retired-bot', true);
      expect(kill.changes).toBe(true);
      expect(ids(kill.reached)).toEqual(['retired-child']);
      expect(await service.previewRevoke('t', 'killed-bot', true)).toMatchObject({
        changes: false,
        reached: [],
      });
    });

    it('stops on a parent chain that loops back', async () => {
      await agents.create([agent('t', 'loop-a', 'loop-b'), agent('t', 'loop-b', 'loop-a')]);

      const preview = await service.previewRevoke('t', 'loop-a', false);

      expect(ids(preview.reached)).toEqual(['loop-b']);
    });

    it('reads only the caller tenant', async () => {
      await agents.create([agent('u', 'parent-bot'), agent('u', 'child-x', 'parent-bot')]);

      await expect(service.previewRevoke('t', 'parent-bot', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // The child was created, then its parentAgentId saved in a second write: a failure between
  // them left an agent the parent's revoke or kill switch did not reach.
  it('stores a delegated agent with its parent in one write', async () => {
    const owners = {
      findOne: () => ({
        select: () => ({
          lean: () => ({
            exec: async () => ({ profile: { status: 'ACTIVE', email: 'owner@example.test' } }),
          }),
        }),
      }),
    };
    const delegating = new NhiService(
      agents,
      owners as never,
      audit as unknown as AuditService,
      events as unknown as DomainEventEmitterService,
    );
    await agents.create(agent('t', 'parent-bot'));
    // Model.create writes through $save, so only a later doc.save() fails
    const save = jest
      .spyOn(agents.prototype, 'save')
      .mockRejectedValue(new Error('connection lost'));

    try {
      await delegating.delegate(
        't',
        'parent-bot',
        {
          agentId: 'child-bot',
          displayName: 'Child bot',
          kind: 'bot',
          ownerIdentityId: 'owner-1',
          scope: ['hr:read'],
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        'admin@example.test',
      );
    } finally {
      save.mockRestore();
    }

    expect(await stored('t', 'child-bot')).toMatchObject({
      parentAgentId: 'parent-bot',
      status: 'active',
    });
    await service.revoke('t', 'parent-bot', {
      reason: 'compromised',
      actor: 'sec@example.test',
      killSwitch: true,
    });
    expect(await stored('t', 'child-bot')).toMatchObject({
      status: 'revoked',
      killSwitchEngaged: true,
    });
  });

  // Hunt 06 F2 (a): the cascade ran only when the agent itself changed, so after a failure part
  // way through it (an audit write, a database hiccup) a retry answered success and did nothing.
  it('completes a cascade that failed part way through when the revoke is retried', async () => {
    await agents.create([
      agent('t', 'parent-bot'),
      agent('t', 'child-1', 'parent-bot'),
      agent('t', 'child-2', 'parent-bot'),
      agent('t', 'grandchild-2', 'child-2'),
    ]);
    audit.log.mockImplementation(async (entry: { resourceId: string }) => {
      if (entry.resourceId === 'child-2') throw new Error('audit write failed');
    });
    const kill = () =>
      service.revoke('t', 'parent-bot', {
        reason: 'compromised',
        actor: 'sec@example.test',
        killSwitch: true,
      });

    await expect(kill()).rejects.toThrow('audit write failed');
    expect(await stored('t', 'grandchild-2')).toMatchObject({ status: 'active' });

    audit.log.mockResolvedValue(undefined);
    await kill();

    for (const agentId of ['parent-bot', 'child-1', 'child-2', 'grandchild-2']) {
      expect(await stored('t', agentId)).toMatchObject({
        status: 'revoked',
        killSwitchEngaged: true,
      });
    }
    // The retry signals the agents it reached (the grandchild), not the parent again
    const signalled = events.emit.mock.calls.map(([, agentId]) => agentId);
    expect(signalled.filter((id) => id === 'grandchild-2')).toHaveLength(1);
    expect(signalled.filter((id) => id === 'parent-bot')).toHaveLength(1);
  });

  // Hunt 06 F2 (b): the walk followed only active agents, so an active agent below a revoked or
  // expired one was out of reach of the revoke, the kill switch and their dry run.
  it('reaches active agents below a revoked or expired delegated agent', async () => {
    await agents.create([
      agent('t', 'parent-bot'),
      { ...agent('t', 'middle-revoked', 'parent-bot'), status: 'revoked', revokedAt: EARLIER },
      agent('t', 'below-revoked', 'middle-revoked'),
      { ...agent('t', 'middle-expired', 'parent-bot'), status: 'expired' },
      agent('t', 'below-expired', 'middle-expired'),
    ]);

    const preview = await service.previewRevoke('t', 'parent-bot', false);
    expect(preview.reached.map((a) => a.agentId).sort()).toEqual([
      'below-expired',
      'below-revoked',
    ]);

    await service.revoke('t', 'parent-bot', { reason: 'retired', actor: 'sec@example.test' });

    for (const agentId of ['below-revoked', 'below-expired']) {
      expect(await stored('t', agentId)).toMatchObject({
        status: 'revoked',
        revocationReason: 'cascade: cascade: retired',
      });
    }
    // The middle agents keep what they were
    expect(await stored('t', 'middle-revoked')).toMatchObject({ revokedAt: EARLIER });
    expect(await stored('t', 'middle-expired')).toMatchObject({ status: 'expired' });
  });

  // Hunt 06 F2 (c): delegate checked the parent, then stored the child; a revoke of the parent
  // in between walked its cascade before the child existed and left it active.
  it('revokes a delegated agent whose parent was revoked while it was being stored', async () => {
    const owners = {
      findOne: () => ({
        select: () => ({
          lean: () => ({
            exec: async () => ({ profile: { status: 'ACTIVE', email: 'owner@example.test' } }),
          }),
        }),
      }),
    };
    const delegating = new NhiService(
      agents,
      owners as never,
      audit as unknown as AuditService,
      events as unknown as DomainEventEmitterService,
    );
    await agents.create(agent('t', 'parent-bot'));
    const create = delegating.create.bind(delegating);
    jest.spyOn(delegating, 'create').mockImplementation(async (...args) => {
      // The kill switch of the parent lands after delegate read it active
      await delegating.revoke('t', 'parent-bot', {
        reason: 'compromised',
        actor: 'sec@example.test',
        killSwitch: true,
      });
      return create(...args);
    });

    await expect(
      delegating.delegate(
        't',
        'parent-bot',
        {
          agentId: 'child-bot',
          displayName: 'Child bot',
          kind: 'bot',
          ownerIdentityId: 'owner-1',
          scope: ['hr:read'],
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        'admin@example.test',
      ),
    ).rejects.toThrow(ConflictException);

    expect(await stored('t', 'child-bot')).toMatchObject({
      parentAgentId: 'parent-bot',
      status: 'revoked',
      killSwitchEngaged: true,
      revokedBy: 'admin@example.test',
    });
  });
});
