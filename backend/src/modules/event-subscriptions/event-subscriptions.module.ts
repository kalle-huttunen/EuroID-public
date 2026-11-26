/**
 * Event Subscriptions Module
 *
 * Provides outbound webhook registry for external systems to receive
 * EuroID domain events. Foundation for SIEM integration.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { eventSubscriptionsConfig } from '@infrastructure/config/event-subscriptions.config';
import { TenantStatusModule } from '@infrastructure/multi-tenancy/tenant-status.service';
import { DeadLetterModule } from '../dead-letter/dead-letter.module';
import { EventSubscription, EventSubscriptionSchema } from './schemas/event-subscription.schema';
import { DeliveryAttempt, DeliveryAttemptSchema } from './schemas/delivery-attempt.schema';
import { EventSubscriptionService } from './event-subscription.service';
import { EventDeliveryService } from './event-delivery.service';
import { EventSubscriptionController } from './event-subscription.controller';

@Module({
  imports: [
    ConfigModule.forFeature(eventSubscriptionsConfig),
    MongooseModule.forFeature([
      { name: EventSubscription.name, schema: EventSubscriptionSchema },
      { name: DeliveryAttempt.name, schema: DeliveryAttemptSchema },
    ]),
    DeadLetterModule,
    TenantStatusModule, // no webhooks for a tenant that is not active
  ],
  controllers: [EventSubscriptionController],
  providers: [EventSubscriptionService, EventDeliveryService],
  exports: [EventSubscriptionService],
})
export class EventSubscriptionsModule {}
