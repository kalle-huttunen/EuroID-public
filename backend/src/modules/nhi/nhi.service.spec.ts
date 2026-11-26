import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NhiService, computeRiskTier, isScopeSubset } from './nhi.service';
import { DomainEventType } from '@infrastructure/events/event-types';

type Doc = Record<string, unknown> & { save: jest.Mock };

function makeOwner(overrides: Partial<{ status: string; deletedAt: Date | null }> = {}) {
  return {
    profile: { status: overrides.status ?? 'ACTIVE', email: 'owner@example.test' },
    deletedAt: overrides.deletedAt ?? undefined,
  };
}

/** Minimal mongoose-shape mock: findOne().select().lean().exec() returns a value. */
function leanChain(value: unknown) {
  return {
    findOne: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(value) }),
      }),
    }),
  };
}

function makeIdentityModel(ownerValue: unknown) {
  return leanChain(ownerValue);
}

function makeAgentModel(options: {
  exists?: unknown;
  docToCreate?: Doc | null;
  existing?: Doc | null;
  children?: Array<{ agentId: string }>;
}) {
  const created = options.docToCreate ?? null;
  const existing = options.existing ?? null;
  const children = options.children ?? [];
  const countQuery = { exec: jest.fn().mockResolvedValue(0) };
  const findQuery = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnThis(),
  };
  const childFindQuery = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(children),
  };
  let findCall = 0;
  return {
    exists: jest.fn().mockResolvedValue(options.exists ?? null),
    create: jest.fn().mockResolvedValue(created),
    findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(existing) }),
    updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    find: jest.fn().mockImplementation(() => {
      // First call inside list() returns paginated empty, second call inside cascade returns children
      findCall++;
      return findCall === 1 ? findQuery : childFindQuery;
    }),
    countDocuments: jest.fn().mockReturnValue(countQuery),
  };
}

function makeAudit() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
    logFireAndForget: jest.fn(),
  };
}

function makeEvents() {
  return { emit: jest.fn() };
}

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    agentId: 'agent-a',
    tenantId: 't',
    displayName: 'Agent A',
    kind: 'workload',
    owner: { identityId: 'owner-1', email: 'owner@example.test' },
    scope: ['hr:read'],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: 'active',
    killSwitchEngaged: false,
    riskTier: 'low',
    createdBy: 'alice@example.test',
    save: jest.fn().mockImplementation(function (this: unknown) {
      return Promise.resolve(this);
    }),
    ...overrides,
  };
}

describe('computeRiskTier', () => {
  it('flags admin wildcard as critical', () => {
    expect(computeRiskTier('workload', ['admin:write'])).toBe('critical');
    expect(computeRiskTier('bot', ['entra:*'])).toBe('critical');
  });

  it('flags long scopes (>10) as critical', () => {
    const scopes = Array.from({ length: 11 }, (_, i) => `s${i}:read`);
    expect(computeRiskTier('bot', scopes)).toBe('critical');
  });

  it('treats service-account as at least high', () => {
    expect(computeRiskTier('service-account', ['hr:read'])).toBe('high');
  });

  it('treats small workload scopes as medium', () => {
    expect(computeRiskTier('workload', ['hr:read'])).toBe('medium');
  });

  it('everything else is low', () => {
    expect(computeRiskTier('bot', ['hr:read'])).toBe('low');
    expect(computeRiskTier('ai-agent', ['hr:read', 'entra:read'])).toBe('low');
  });
});

describe('isScopeSubset', () => {
  it('returns true when child is subset', () => {
    expect(isScopeSubset(['a', 'b', 'c'], ['a', 'b'])).toBe(true);
    expect(isScopeSubset(['a'], [])).toBe(true);
  });

  it('returns false otherwise', () => {
    expect(isScopeSubset(['a'], ['a', 'b'])).toBe(false);
    expect(isScopeSubset([], ['a'])).toBe(false);
  });
});

describe('NhiService', () => {
  const tenantId = 't';
  const actor = 'alice@example.test';
  const validDto = () => ({
    agentId: 'agent-a',
    displayName: 'Agent A',
    kind: 'workload' as const,
    ownerIdentityId: 'owner-1',
    scope: ['hr:read'],
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  it('creates an agent when owner is active', async () => {
    const doc = makeDoc();
    const agentModel = makeAgentModel({ exists: null, docToCreate: doc });
    const identityModel = makeIdentityModel(makeOwner());
    const audit = makeAudit();
    const events = makeEvents();
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      audit as never,
      events as never,
    );

    const out = await svc.create(tenantId, validDto(), actor);
    expect(out).toBe(doc);
    expect(agentModel.create).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AGENT_IDENTITY_CREATED', severity: 'info' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.NHI_CREATED,
      'agent-a',
      expect.objectContaining({ agentId: 'agent-a', ownerIdentityId: 'owner-1' }),
      expect.objectContaining({ tenantId, actor }),
    );
  });

  it('rejects when the owner identity is missing', async () => {
    const agentModel = makeAgentModel({ exists: null, docToCreate: makeDoc() });
    const identityModel = makeIdentityModel(null);
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      makeAudit() as never,
      makeEvents() as never,
    );
    await expect(svc.create(tenantId, validDto(), actor)).rejects.toThrow(BadRequestException);
  });

  it('rejects when the owner identity is not active', async () => {
    const agentModel = makeAgentModel({ exists: null, docToCreate: makeDoc() });
    const identityModel = makeIdentityModel(makeOwner({ status: 'SUSPENDED' }));
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      makeAudit() as never,
      makeEvents() as never,
    );
    await expect(svc.create(tenantId, validDto(), actor)).rejects.toThrow(/must be active/);
  });

  it('rejects duplicate agentId', async () => {
    const agentModel = makeAgentModel({ exists: { _id: 'x' }, docToCreate: makeDoc() });
    const identityModel = makeIdentityModel(makeOwner());
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      makeAudit() as never,
      makeEvents() as never,
    );
    await expect(svc.create(tenantId, validDto(), actor)).rejects.toThrow(/already exists/);
  });

  it('clamps expiresAt to 90 days when a longer value is supplied', async () => {
    const doc = makeDoc();
    const agentModel = makeAgentModel({ exists: null, docToCreate: doc });
    const identityModel = makeIdentityModel(makeOwner());
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      makeAudit() as never,
      makeEvents() as never,
    );
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    await svc.create(tenantId, { ...validDto(), expiresAt: farFuture }, actor);
    const [createArg] = (agentModel.create as jest.Mock).mock.calls[0];
    const diffDays = (createArg.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(89);
    expect(diffDays).toBeLessThanOrEqual(90);
  });

  it('delegate enforces scope subset and expiresAt bound', async () => {
    const parent = makeDoc({
      agentId: 'parent',
      scope: ['hr:read', 'entra:read'],
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    const child = makeDoc({ agentId: 'child', parentAgentId: 'parent' });
    const agentModel = makeAgentModel({ exists: null, docToCreate: child, existing: parent });
    const identityModel = makeIdentityModel(makeOwner());
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      makeAudit() as never,
      makeEvents() as never,
    );

    // Bad subset — contains scope parent does not have.
    await expect(
      svc.delegate(
        tenantId,
        'parent',
        {
          agentId: 'child',
          displayName: 'C',
          kind: 'bot',
          ownerIdentityId: 'owner-1',
          scope: ['hr:read', 'slack:admin'],
          expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
        },
        actor,
      ),
    ).rejects.toThrow(/subset/);
  });

  it('delegate rejects expiresAt after parent', async () => {
    const parent = makeDoc({
      agentId: 'parent',
      scope: ['hr:read'],
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const agentModel = makeAgentModel({ exists: null, docToCreate: makeDoc(), existing: parent });
    const identityModel = makeIdentityModel(makeOwner());
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      makeAudit() as never,
      makeEvents() as never,
    );
    await expect(
      svc.delegate(
        tenantId,
        'parent',
        {
          agentId: 'child',
          displayName: 'C',
          kind: 'bot',
          ownerIdentityId: 'owner-1',
          scope: ['hr:read'],
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        actor,
      ),
    ).rejects.toThrow(/expiresAt/);
  });

  it('revoke sets status and emits NHI_REVOKED', async () => {
    const doc = makeDoc();
    const agentModel = makeAgentModel({ exists: null, docToCreate: doc, existing: doc });
    const identityModel = makeIdentityModel(makeOwner());
    const events = makeEvents();
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      makeAudit() as never,
      events as never,
    );
    const out = await svc.revoke(tenantId, 'agent-a', { reason: 'leak', actor });
    expect(out.status).toBe('revoked');
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.NHI_REVOKED,
      'agent-a',
      expect.objectContaining({ killSwitch: false }),
      expect.anything(),
    );
  });

  it('kill-switch emits NHI_KILL_SWITCH_ENGAGED at critical severity', async () => {
    const doc = makeDoc();
    const agentModel = makeAgentModel({ exists: null, docToCreate: doc, existing: doc });
    const identityModel = makeIdentityModel(makeOwner());
    const audit = makeAudit();
    const events = makeEvents();
    const svc = new NhiService(
      agentModel as never,
      identityModel as never,
      audit as never,
      events as never,
    );
    const out = await svc.revoke(tenantId, 'agent-a', {
      reason: 'compromise',
      actor,
      killSwitch: true,
    });
    expect(out.killSwitchEngaged).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AGENT_IDENTITY_KILL_SWITCH', severity: 'critical' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.NHI_KILL_SWITCH_ENGAGED,
      'agent-a',
      expect.anything(),
      expect.anything(),
    );
  });

  // It saved the whole document, which could overwrite a revoke that landed in between; the
  // stored outcome is tested on MongoDB in nhi-expiry.integration.spec.ts.
  it('mustGet marks the agent expired in its tenant before reading it', async () => {
    const doc = makeDoc({ expiresAt: new Date(Date.now() - 1000) });
    const agentModel = makeAgentModel({ existing: doc });
    const svc = new NhiService(
      agentModel as never,
      makeIdentityModel(makeOwner()) as never,
      makeAudit() as never,
      makeEvents() as never,
    );
    const out = await svc.mustGet(tenantId, 'agent-a');
    expect(out).toBe(doc);
    expect(agentModel.updateMany).toHaveBeenCalledWith(
      { tenantId, agentId: 'agent-a', status: 'active', expiresAt: { $lte: expect.any(Date) } },
      { $set: { status: 'expired' } },
    );
    expect(agentModel.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      agentModel.findOne.mock.invocationCallOrder[0],
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('mustGet throws NotFound when no doc', async () => {
    const agentModel = makeAgentModel({ existing: null });
    const svc = new NhiService(
      agentModel as never,
      makeIdentityModel(makeOwner()) as never,
      makeAudit() as never,
      makeEvents() as never,
    );
    await expect(svc.mustGet(tenantId, 'missing')).rejects.toThrow(NotFoundException);
  });
});
