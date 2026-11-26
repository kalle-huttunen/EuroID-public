import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { IdentityDeletedPayload } from '@infrastructure/events/event-payloads';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { Identity, type IdentityDocument } from '../identity/schemas/identity.schema';
import { PamSessionService } from './pam-session.service';

/**
 * A deleted admin identity (offboarding, a bulk rollback, erasure) holds no privileged session:
 * its running session is told to end, and disables what it enabled on its way out. Offboarding
 * already signals it at its start (getLinkedAdminIdentities); this covers every other way an
 * admin identity is deleted. Signals only: a session that does not run starts nothing.
 */
@Injectable()
export class PamSessionEndHandler {
  private readonly logger = this.loggerFactory.create(PamSessionEndHandler.name);

  constructor(
    @InjectModel(Identity.name) private readonly identityModel: Model<IdentityDocument>,
    private readonly sessions: PamSessionService,
    private readonly loggerFactory: LoggerFactoryService,
  ) {}

  @OnEvent(DomainEventType.IDENTITY_DELETED, { async: true })
  async onIdentityDeleted(event: DomainEvent<IdentityDeletedPayload>): Promise<void> {
    const identityId = event.payload.identityId;
    const tenantId = event.metadata.tenantId;
    if (!isValidObjectId(identityId) || !tenantId) return;
    try {
      const identity = await this.identityModel
        .findOne({ _id: identityId, tenantId })
        .select('parentIdentityId')
        .lean()
        .exec();
      if (!identity?.parentIdentityId) return;
      if (await this.sessions.endIfRunning(identityId, tenantId, 'offboarded')) {
        this.logger.log(`Ended the privileged session of deleted admin identity ${identityId}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not end the session of deleted identity ${identityId}: ${msg}`);
    }
  }
}
