/**
 * Notifications Module
 *
 * Email notifications (SMTP, nodemailer) next to the in-app Socket.IO events: approvers of access
 * requests, reviewers of access reviews, owners of expiring time-bound access, the drift alert of
 * a reconciliation run (notifyEmail), and the console admin password reset link (PasswordResetMailService, for modules/auth). Off unless the
 * deployment sets SMTP_HOST (mail.config.ts). Design: docs/ARCHITECTURE.md.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { mailConfig } from '@infrastructure/config/mail.config';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { DeadLetterModule } from '../dead-letter/dead-letter.module';
import { IdentityModule } from '../identity/identity.module';
import { IdentityService } from '../identity/identity.service';
import { AdminUser, AdminUserSchema } from '../auth/schemas/admin-user.schema';
import { ReviewItem, ReviewItemSchema } from '../access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  ReviewCampaignSchema,
} from '../access-review/schemas/review-campaign.schema';
import { EmailNotification, EmailNotificationSchema } from './schemas/email-notification.schema';
import { MailTransportService } from './mail-transport.service';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailRecipientsService } from './email-recipients.service';
import { EmailNotificationService } from './email-notification.service';
import { EmailNotificationHandler } from './email-notification.handler';
import { PasswordResetMailService } from './password-reset-mail.service';

@Module({
  imports: [
    ConfigModule.forFeature(mailConfig),
    MongooseModule.forFeature([
      { name: EmailNotification.name, schema: EmailNotificationSchema },
      { name: AdminUser.name, schema: AdminUserSchema },
      { name: ReviewItem.name, schema: ReviewItemSchema },
      { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
    ]),
    DeadLetterModule,
    IdentityModule, // Provides IdentityService as IDENTITY_QUERY_PORT implementation
  ],
  providers: [
    MailTransportService,
    EmailDeliveryService,
    EmailRecipientsService,
    EmailNotificationService,
    EmailNotificationHandler,
    PasswordResetMailService,
    { provide: IDENTITY_QUERY_PORT, useExisting: IdentityService },
  ],
  exports: [EmailNotificationService, PasswordResetMailService],
})
export class NotificationsModule {}
