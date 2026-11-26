/**
 * Expiry on read, on in-memory MongoDB: GET /nhi and GET /nhi/:agentId answer `expired` for an
 * agent past its expiresAt and store it, so `?status=expired` finds it and `?status=active` does
 * not. Before, only the writes marked an agent expired, so the registry listed expired agents as
 * active. Only the caller tenant's agents still stored as active change: a revoked agent stays
 * revoked.
 */
import mongoose, { Model } from 'mongoose';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { NhiService } from './nhi.service';
import {
  AgentIdentity,
  AgentIdentitySchema,
  type AgentIdentityDocument,
} from './schemas/agent-identity.schema';

describe('NhiService expiry on read (in-memory MongoDB)', () => {
  let agents: Model<AgentIdentityDocument>;
  let service: NhiService;
  const PAST = new Date(Date.now() - 60 * 60 * 1000);
  const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const agent = (tenantId: string, agentId: string, expiresAt: Date, status = 'active') => ({
    tenantId,
    agentId,
    displayName: agentId,
    kind: 'workload',
    owner: { identityId: 'owner-1', email: 'owner@example.test' },
    scope: ['hr:read'],
    expiresAt,
    status,
    createdBy: 'admin@example.test',
  });
  const stored = (tenantId: string, agentId: string) =>
    agents.findOne({ tenantId, agentId }).lean().exec();
  const listed = async (tenantId: string, status?: 'active' | 'expired') => {
    const { data, total } = await service.list(tenantId, { status }, 1, 50);
    return { rows: data.map((a) => [a.agentId, a.status]).sort(), total };
  };

  beforeAll(async () => {
    await connectTestDb();
    agents = mongoose.model(
      AgentIdentity.name,
      AgentIdentitySchema,
    ) as unknown as Model<AgentIdentityDocument>;
    // Reads write no audit entry and emit nothing
    service = new NhiService(agents, undefined as never, undefined as never, undefined as never);
  });

  beforeEach(async () => {
    await agents.create([
      agent('t', 'stale-bot', PAST),
      agent('t', 'live-bot', FUTURE),
      agent('t', 'retired-bot', PAST, 'revoked'),
      agent('u', 'stale-bot', PAST),
    ]);
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('lists an agent past its expiry as expired, and the status filters agree', async () => {
    expect(await listed('t')).toEqual({
      rows: [
        ['live-bot', 'active'],
        ['retired-bot', 'revoked'],
        ['stale-bot', 'expired'],
      ],
      total: 3,
    });
    expect(await listed('t', 'expired')).toEqual({ rows: [['stale-bot', 'expired']], total: 1 });
    expect(await listed('t', 'active')).toEqual({ rows: [['live-bot', 'active']], total: 1 });

    expect(await stored('t', 'stale-bot')).toMatchObject({ status: 'expired' });
    // A revoked agent past its expiry stays revoked; another tenant's agent is not touched
    expect(await stored('t', 'retired-bot')).toMatchObject({ status: 'revoked' });
    expect(await stored('u', 'stale-bot')).toMatchObject({ status: 'active' });
  });

  it('filters by expired on the first read', async () => {
    expect(await listed('t', 'expired')).toEqual({ rows: [['stale-bot', 'expired']], total: 1 });
  });

  it('reads one agent past its expiry as expired, in the caller tenant only', async () => {
    expect(await service.get('t', 'stale-bot')).toMatchObject({ status: 'expired' });
    expect(await stored('t', 'stale-bot')).toMatchObject({ status: 'expired' });
    expect(await stored('u', 'stale-bot')).toMatchObject({ status: 'active' });

    expect(await service.get('t', 'live-bot')).toMatchObject({ status: 'active' });
    expect(await service.get('t', 'retired-bot')).toMatchObject({ status: 'revoked' });
    expect(await service.get('t', 'missing-bot')).toBeNull();
  });
});
