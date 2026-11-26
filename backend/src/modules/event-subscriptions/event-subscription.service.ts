/**
 * Event Subscription Service
 *
 * CRUD for webhook subscriptions. Validates webhook URLs against SSRF,
 * encrypts signing secrets at rest, enforces per-tenant subscription limits.
 * Answers never carry the signing secret or a custom header value (EventSubscriptionView).
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { EventSubscription, EventSubscriptionDocument } from './schemas/event-subscription.schema';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { validateUrlForFetch } from '@infrastructure/url-validation/ssrf-guard';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import {
  CreateEventSubscriptionDto,
  CreateEventSubscriptionSchema,
} from './dtos/create-event-subscription.dto';
import {
  UpdateEventSubscriptionDto,
  UpdateEventSubscriptionSchema,
} from './dtos/update-event-subscription.dto';
import { headersAfterEdit } from './webhook-headers';
import { matchesEventType } from './subscription-filters';
import { EventSubscriptionView, StoredSubscription, toView } from './event-subscription.view';

/**
 * The answer to a webhook URL the SSRF guard refuses. The guard's own text names the address the
 * host resolves to, which a tenant admin must not learn about the platform's network.
 */
export const WEBHOOK_URL_REFUSED =
  'Webhook URL refused: it must use https, and its host must not be or resolve to a private, loopback, link-local or cloud metadata address.';

/**
 * MongoDB's duplicate key error: a subscription's unique { tenantId, name }, a delivery attempt's
 * unique { subscriptionId, eventId } (EventDeliveryService).
 */
export const isDuplicateKey = (err: unknown) =>
  err instanceof Error && 'code' in err && (err as { code: unknown }).code === 11000;

const nameTaken = (name: string) =>
  new ConflictException(`A webhook subscription named "${name}" already exists.`);

@Injectable()
export class EventSubscriptionService {
  private readonly logger = new Logger(EventSubscriptionService.name);

  constructor(
    @InjectModel(EventSubscription.name)
    private readonly model: Model<EventSubscriptionDocument>,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  async create(body: unknown, actor: string): Promise<EventSubscriptionView> {
    const dto = CreateEventSubscriptionSchema.parse(body);
    const tenantId = getCurrentTenantId();

    // Enforce per-tenant subscription limit
    const maxSubs =
      this.configService.get<number>('eventSubscriptions.WEBHOOK_MAX_SUBSCRIPTIONS_PER_TENANT') ??
      10;
    const count = await this.model.countDocuments({ tenantId });
    if (count >= maxSubs) {
      throw new BadRequestException(`Maximum subscriptions per tenant (${maxSubs}) reached`);
    }

    // SSRF validation on webhook URL
    await this.assertWebhookUrlAllowed(dto.webhook.url);

    // Encrypt signing secret at rest
    const encryptedSecret = await this.encryptionService.encrypt(dto.webhook.signingSecret);

    try {
      const doc = await this.model.create({
        tenantId,
        name: dto.name,
        type: 'WEBHOOK',
        status: 'ACTIVE',
        filters: dto.filters,
        webhook: {
          url: dto.webhook.url,
          headers: dto.webhook.headers,
          signingSecret: encryptedSecret,
        },
        createdBy: actor,
      });

      this.eventEmitter.emit(
        DomainEventType.WEBHOOK_SUBSCRIPTION_CREATED,
        String(doc._id),
        {
          subscriptionId: String(doc._id),
          name: dto.name,
          // The host only: the event reaches every socket of the tenant and the audit log, and a
          // receiver's URL can carry its token in the path, the query or the user info.
          webhookHost: new URL(dto.webhook.url).host,
        },
        { actor, tenantId },
      );

      return toView(doc);
    } catch (err: unknown) {
      // Another subscription of the tenant has this name: the new URL and secret are not stored.
      if (isDuplicateKey(err)) throw nameTaken(dto.name);
      throw err;
    }
  }

  async findAll(): Promise<EventSubscriptionView[]> {
    const tenantId = getCurrentTenantId();
    const docs = await this.model.find({ tenantId }).sort({ createdAt: -1 }).lean().exec();
    return docs.map(toView);
  }

  async findOne(id: string): Promise<EventSubscriptionView> {
    return toView(await this.findStored(id));
  }

  /**
   * The stored subscription, signing secret and header values included: for sending a delivery
   * (the test route), never for an answer.
   */
  async findStored(id: string): Promise<EventSubscriptionDocument> {
    const tenantId = getCurrentTenantId();
    const doc = await this.model.findOne({ _id: id, tenantId }).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Subscription ${id} not found`);
    }
    return doc;
  }

  async update(id: string, body: unknown, actor: string): Promise<EventSubscriptionView> {
    const dto = UpdateEventSubscriptionSchema.parse(body);
    const tenantId = getCurrentTenantId();
    const existing = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!existing) {
      throw new NotFoundException(`Subscription ${id} not found`);
    }

    const update: Record<string, unknown> = {};
    if (dto.name) update.name = dto.name;
    if (dto.status) update.status = dto.status;
    if (dto.filters) update.filters = dto.filters;

    if (dto.webhook) {
      if (dto.webhook.url) {
        await this.assertWebhookUrlAllowed(dto.webhook.url);
        update['webhook.url'] = dto.webhook.url;
      }
      if (dto.webhook.headers !== undefined) {
        update['webhook.headers'] = headersAfterEdit(
          existing.webhook?.headers,
          dto.webhook.headers,
        );
      }
      if (dto.webhook.signingSecret) {
        update['webhook.signingSecret'] = await this.encryptionService.encrypt(
          dto.webhook.signingSecret,
        );
      }
    }

    let updated: StoredSubscription | null;
    try {
      updated = await this.model
        .findOneAndUpdate({ _id: id, tenantId }, { $set: update }, { new: true })
        .lean()
        .exec();
    } catch (err: unknown) {
      if (isDuplicateKey(err)) throw nameTaken(dto.name ?? existing.name);
      throw err;
    }
    if (!updated) {
      throw new NotFoundException(`Subscription ${id} not found`);
    }
    const changed = Object.keys(update);
    if (changed.length > 0) {
      // Audited like create and delete: what changed, and the new receiver's host only (never
      // the URL, a header value or the secret)
      this.eventEmitter.emit(
        DomainEventType.WEBHOOK_SUBSCRIPTION_UPDATED,
        id,
        {
          subscriptionId: id,
          name: updated.name,
          changed,
          ...(dto.webhook?.url ? { webhookHost: new URL(dto.webhook.url).host } : {}),
        },
        { actor, tenantId },
      );
    }
    return toView(updated);
  }

  async remove(id: string, actor: string): Promise<void> {
    const tenantId = getCurrentTenantId();
    const doc = await this.model.findOneAndDelete({ _id: id, tenantId }).exec();
    if (!doc) {
      throw new NotFoundException(`Subscription ${id} not found`);
    }

    this.eventEmitter.emit(
      DomainEventType.WEBHOOK_SUBSCRIPTION_DELETED,
      id,
      { subscriptionId: id, name: doc.name },
      { actor, tenantId },
    );
  }

  /** 400 for a URL the SSRF guard refuses; it throws a plain Error, which the API answered 500. */
  private async assertWebhookUrlAllowed(url: string): Promise<void> {
    try {
      await validateUrlForFetch(url);
    } catch (err: unknown) {
      this.logger.warn(`Webhook URL refused: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadRequestException(WEBHOOK_URL_REFUSED);
    }
  }

  /** The tenant's ACTIVE subscriptions. Used by EventDeliveryService and its retry poller. */
  async getActiveSubscriptions(tenantId: string): Promise<EventSubscriptionDocument[]> {
    return this.model.find({ tenantId, status: 'ACTIVE' }).lean().exec();
  }

  /**
   * Find ACTIVE subscriptions whose filter patterns match a given event type.
   * Used by EventDeliveryService.
   */
  async getActiveSubscriptionsForEvent(
    eventType: string,
    tenantId: string,
  ): Promise<EventSubscriptionDocument[]> {
    const active = await this.getActiveSubscriptions(tenantId);

    return active.filter((sub) =>
      sub.filters.eventTypes.some((pattern) => this.matchesEventType(pattern, eventType)),
    );
  }

  /**
   * The tenants with at least one ACTIVE subscription: the webhook retry poller works through
   * them, each in its own tenant context. A system query, run outside any request.
   */
  async tenantsWithActiveSubscriptions(): Promise<string[]> {
    const tenants = await this.model
      .distinct('tenantId', { status: 'ACTIVE' })
      .setOptions({ skipTenantScope: true })
      .exec();
    return tenants.map(String);
  }

  /** Glob-style matching for event type patterns (subscription-filters.ts). */
  matchesEventType(pattern: string, eventType: string): boolean {
    return matchesEventType(pattern, eventType);
  }
}
