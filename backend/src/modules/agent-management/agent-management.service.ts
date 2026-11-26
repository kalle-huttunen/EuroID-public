import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { Agent, AgentDocument } from './agent.schema';
import { RegisterAgentDto, HeartbeatDto } from './agent.dto';
import { AGENT_CONFIG } from './agent-management.config';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';

const DEFAULT_TENANT = 'dev-tenant';

@Injectable()
export class AgentManagementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentManagementService.name);
  private staleCheckTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<AgentDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  onModuleInit() {
    // A failed check (MongoDB unreachable) is logged and the next tick tries again: a rejection
    // left unhandled would end the API process. unref: the timer alone keeps no process alive.
    this.staleCheckTimer = setInterval(() => {
      this.markStaleAgents().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Stale agent check failed, retrying on the next interval: ${message}`);
      });
    }, AGENT_CONFIG.STALE_CHECK_INTERVAL_MS);
    this.staleCheckTimer.unref();
  }

  onModuleDestroy() {
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
  }

  private getTenantId(): string {
    return requestContext.getStore()?.tenantId || DEFAULT_TENANT;
  }

  async register(dto: RegisterAgentDto): Promise<AgentDocument> {
    const tenantId = this.getTenantId();

    const count = await this.agentModel.countDocuments({
      tenantId,
      status: { $ne: 'decommissioned' },
    });
    if (count >= AGENT_CONFIG.MAX_PER_TENANT) {
      throw new BadRequestException(
        `Maximum of ${AGENT_CONFIG.MAX_PER_TENANT} agents per tenant reached`,
      );
    }

    const agentId = `agent-${randomUUID()}`;
    const now = new Date();

    try {
      const agent = await this.agentModel.create({
        agentId,
        tenantId,
        name: dto.name,
        status: 'online',
        connectorTypes: dto.connectorTypes,
        taskQueue: dto.taskQueue,
        version: dto.version,
        metadata: dto.metadata,
        certificate: dto.certificate,
        lastHeartbeat: now,
        registeredAt: now,
      });

      this.eventEmitter.emit(DomainEventType.CONNECTOR_HEALTH_CHANGED, agentId, {
        agentId,
        status: 'online',
        name: dto.name,
      });

      this.logger.log(`Agent registered: ${agentId} (${dto.name}) for tenant ${tenantId}`);
      return agent;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: number }).code === 11000
      ) {
        throw new ConflictException('Agent with this ID already exists');
      }
      throw err;
    }
  }

  async heartbeat(agentId: string, dto: HeartbeatDto): Promise<AgentDocument> {
    const tenantId = this.getTenantId();
    const agent = await this.agentModel.findOneAndUpdate(
      { agentId, tenantId, status: { $ne: 'decommissioned' } },
      {
        $set: {
          lastHeartbeat: new Date(),
          status: dto.status ?? 'online',
          ...(dto.version && { version: dto.version }),
          ...(dto.metadata && { metadata: dto.metadata }),
        },
      },
      { new: true },
    );

    if (!agent) {
      throw new NotFoundException(`Agent ${agentId} not found or decommissioned`);
    }
    return agent;
  }

  async findAll(): Promise<AgentDocument[]> {
    const tenantId = this.getTenantId();
    return this.agentModel
      .find({ tenantId, status: { $ne: 'decommissioned' } })
      .sort({ registeredAt: -1 })
      .lean()
      .exec() as Promise<AgentDocument[]>;
  }

  async findById(agentId: string): Promise<AgentDocument> {
    const tenantId = this.getTenantId();
    const agent = await this.agentModel.findOne({ agentId, tenantId }).lean().exec();
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);
    return agent as AgentDocument;
  }

  async getStatusSummary(): Promise<{
    online: number;
    offline: number;
    degraded: number;
    total: number;
  }> {
    const tenantId = this.getTenantId();
    const agents = await this.agentModel
      .find({ tenantId, status: { $ne: 'decommissioned' } })
      .select('status')
      .lean()
      .exec();

    const counts = { online: 0, offline: 0, degraded: 0, total: agents.length };
    for (const a of agents) {
      const status = (a as { status: string }).status;
      if (status === 'online') counts.online++;
      else if (status === 'offline') counts.offline++;
      else if (status === 'degraded') counts.degraded++;
    }
    return counts;
  }

  async decommission(agentId: string): Promise<AgentDocument> {
    const tenantId = this.getTenantId();
    const agent = await this.agentModel.findOneAndUpdate(
      { agentId, tenantId, status: { $ne: 'decommissioned' } },
      { $set: { status: 'decommissioned', decommissionedAt: new Date() } },
      { new: true },
    );

    if (!agent) {
      throw new NotFoundException(`Agent ${agentId} not found or already decommissioned`);
    }

    this.eventEmitter.emit(DomainEventType.CONNECTOR_HEALTH_CHANGED, agentId, {
      agentId,
      status: 'decommissioned',
      name: agent.name,
    });

    this.logger.log(`Agent decommissioned: ${agentId}`);
    return agent;
  }

  private async markStaleAgents(): Promise<void> {
    const threshold = new Date(
      Date.now() -
        AGENT_CONFIG.HEARTBEAT_INTERVAL_SECONDS * AGENT_CONFIG.STALE_THRESHOLD_MULTIPLIER * 1000,
    );

    const result = await this.agentModel.updateMany(
      {
        status: { $in: ['online', 'degraded'] },
        lastHeartbeat: { $lt: threshold },
      },
      { $set: { status: 'offline' } },
      { skipTenantScope: true } as Record<string, unknown>,
    );

    if (result.modifiedCount > 0) {
      this.logger.warn(`Marked ${result.modifiedCount} agent(s) as offline (stale heartbeat)`);
    }
  }
}
