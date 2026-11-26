/**
 * Heartbeat and decommission of a remote agent on in-memory MongoDB, without the tenant plugin:
 * the service's own filter keeps both to the request tenant. An agent of another tenant answers
 * 404, and of an agentId both tenants use only the caller tenant's agent changes.
 */
import mongoose, { Model } from 'mongoose';
import { NotFoundException } from '@nestjs/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { AgentManagementService } from './agent-management.service';
import { Agent, AgentSchema, type AgentDocument } from './agent.schema';
import type { HeartbeatDto } from './agent.dto';

describe('AgentManagementService tenant scope (in-memory MongoDB)', () => {
  let agents: Model<AgentDocument>;
  let service: AgentManagementService;
  const events = { emit: jest.fn() };
  const LAST = new Date('2026-11-01T10:00:00.000Z');

  const agent = (tenantId: string, agentId: string) => ({
    tenantId,
    agentId,
    name: `Agent ${agentId}`,
    status: 'online',
    taskQueue: `agent-${tenantId}`,
    lastHeartbeat: LAST,
  });
  const stored = (tenantId: string, agentId: string) =>
    agents.findOne({ tenantId, agentId }).lean().exec();
  const inTenantA = <T>(fn: () => Promise<T>) => withTenantContext('tenant-a', fn) as Promise<T>;

  beforeAll(async () => {
    await connectTestDb();
    agents = mongoose.model(Agent.name, AgentSchema) as unknown as Model<AgentDocument>;
    await agents.init();
    service = new AgentManagementService(agents, events as unknown as DomainEventEmitterService);
  });

  beforeEach(async () => {
    await agents.create([
      agent('tenant-a', 'agent-shared'),
      agent('tenant-b', 'agent-shared'),
      agent('tenant-b', 'agent-b-only'),
    ]);
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("heartbeat answers 404 for another tenant's agent and updates only the caller's", async () => {
    await expect(
      inTenantA(() => service.heartbeat('agent-b-only', {} as HeartbeatDto)),
    ).rejects.toThrow(NotFoundException);
    await inTenantA(() =>
      service.heartbeat('agent-shared', { status: 'degraded' } as HeartbeatDto),
    );

    const mine = await stored('tenant-a', 'agent-shared');
    expect(mine?.status).toBe('degraded');
    expect(mine?.lastHeartbeat?.getTime()).toBeGreaterThan(LAST.getTime());
    for (const agentId of ['agent-shared', 'agent-b-only']) {
      expect(await stored('tenant-b', agentId)).toMatchObject({
        status: 'online',
        lastHeartbeat: LAST,
      });
    }
  });

  it("decommission answers 404 for another tenant's agent and retires only the caller's", async () => {
    await expect(inTenantA(() => service.decommission('agent-b-only'))).rejects.toThrow(
      NotFoundException,
    );
    await inTenantA(() => service.decommission('agent-shared'));

    expect(await stored('tenant-a', 'agent-shared')).toMatchObject({ status: 'decommissioned' });
    expect(await stored('tenant-b', 'agent-shared')).toMatchObject({ status: 'online' });
    expect(await stored('tenant-b', 'agent-b-only')).toMatchObject({ status: 'online' });
    // One health change: the caller's agent
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});
