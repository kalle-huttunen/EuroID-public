/**
 * A failed email is retried by the dead-letter queue's automatic retry (in-memory MongoDB with the
 * tenant plugin, the real DeadLetterService and Nest event emitter, nodemailer's JSON transport):
 * the poller runs outside any request, so this also covers the tenant context of that retry.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { createTransport } from 'nodemailer';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { type MailConfig, mailConfig } from '@infrastructure/config/mail.config';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import {
  DeadLetterEntry,
  DeadLetterEntryDocument,
  DeadLetterEntrySchema,
} from '../dead-letter/schemas/dead-letter.schema';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { AdminUser, AdminUserSchema, AdminUserDocument } from '../auth/schemas/admin-user.schema';
import { ReviewItem, ReviewItemSchema } from '../access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  ReviewCampaignSchema,
} from '../access-review/schemas/review-campaign.schema';
import {
  EmailNotification,
  EmailNotificationDocument,
  EmailNotificationSchema,
} from './schemas/email-notification.schema';
import { MAIL_SENDER, MailTransportService, type OutgoingMail } from './mail-transport.service';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailRecipientsService } from './email-recipients.service';
import { EmailNotificationService, type ApproverNotice } from './email-notification.service';
import { EmailNotificationHandler } from './email-notification.handler';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';

const CONF: MailConfig = {
  enabled: true,
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTls: true,
  from: 'EuroID <no-reply@euroid.example>',
  timeoutMs: 1000,
  frontendUrl: 'https://euroid.example',
};

const APPROVAL: ApproverNotice = {
  requestId: 'req-1',
  stepIndex: 0,
  stepCount: 1,
  approverEmail: 'manager@a.example',
  requesterId: 'requester-id',
  requesterEmail: 'requester@a.example',
  entitlements: [{ system: 'entra-id', name: 'Sales Team' }],
};

describe('Email notifications: automatic dead-letter retry (MongoDB)', () => {
  let moduleRef: TestingModule;
  let notifications: EmailNotificationService;
  let dlq: DeadLetterService;
  let dlqModel: Model<DeadLetterEntryDocument>;
  let mailModel: Model<EmailNotificationDocument>;

  const sent: Array<{ to: Array<{ address: string }> }> = [];
  let failWith: Error | null = null;
  const json = createTransport({ jsonTransport: true });
  const sender = {
    sendMail: async (message: OutgoingMail & { from: string }) => {
      if (failWith) throw failWith;
      const info = await json.sendMail(message);
      sent.push(JSON.parse(info.message) as { to: Array<{ address: string }> });
      return info;
    },
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: EmailNotification.name, schema: EmailNotificationSchema },
          { name: DeadLetterEntry.name, schema: DeadLetterEntrySchema },
          { name: AdminUser.name, schema: AdminUserSchema },
          { name: ReviewItem.name, schema: ReviewItemSchema },
          { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
        ]),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
      ],
      providers: [
        DeadLetterService,
        MailTransportService,
        EmailDeliveryService,
        EmailRecipientsService,
        EmailNotificationService,
        EmailNotificationHandler,
        // Defaults: DLQ_MAX_RETRIES 3, poll every 60 s (the test calls the poll itself).
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PluginRegistryService, useValue: { getSecretConfigKeys: () => null } },
        { provide: mailConfig.KEY, useValue: CONF },
        { provide: MAIL_SENDER, useValue: sender },
        {
          provide: IDENTITY_QUERY_PORT,
          useValue: { findByEmail: async () => null, findById: async () => null },
        },
      ],
    }).compile();
    await moduleRef.init(); // registers the @OnEvent listeners

    notifications = moduleRef.get(EmailNotificationService);
    dlq = moduleRef.get(DeadLetterService);
    dlqModel = moduleRef.get(getModelToken(DeadLetterEntry.name));
    mailModel = moduleRef.get(getModelToken(EmailNotification.name));
    await mailModel.init();
    const admins = moduleRef.get<Model<AdminUserDocument>>(getModelToken(AdminUser.name));
    await admins.create({
      email: 'manager@a.example',
      passwordHash: 'x',
      name: 'Manager A',
      tenantId: A,
    });
  });

  afterEach(async () => {
    await mailModel.deleteMany({}).setOptions({ skipTenantScope: true });
    await dlqModel.deleteMany({}).setOptions({ skipTenantScope: true });
    sent.length = 0;
    failWith = null;
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const entries = () => dlqModel.find({}).setOptions({ skipTenantScope: true }).lean().exec();
  const mails = () => mailModel.find({}).setOptions({ skipTenantScope: true }).lean().exec();
  const makeDue = () =>
    dlqModel
      .updateMany({}, { $set: { nextRetryAt: new Date(Date.now() - 1000) } })
      .setOptions({ skipTenantScope: true })
      .exec();

  async function failOnce(): Promise<void> {
    failWith = new Error('421 4.3.2 service not available');
    await expect(notifications.notifyApprover(A, APPROVAL)).resolves.toBe('failed');
    expect(await entries()).toMatchObject([
      {
        tenantId: A,
        type: 'event_handler_failure',
        source: 'email:approval-requested',
        status: 'pending',
      },
    ]);
    await makeDue();
  }

  it('sends a failed mail on the next automatic retry, which runs without a request', async () => {
    await failOnce();
    failWith = null;

    expect(requestContext.getStore()).toBeUndefined();
    await dlq.processAutoRetries();

    expect(sent.map((m) => m.to[0].address)).toEqual(['manager@a.example']);
    expect(await entries()).toMatchObject([
      { status: 'replayed', resolvedBy: 'auto-retry-poller' },
    ]);
    expect(await mails()).toMatchObject([{ status: 'SENT', attempts: 2 }]);
  });

  it('backs off while the server still refuses, then sends', async () => {
    await failOnce();

    await dlq.processAutoRetries();
    expect(sent).toHaveLength(0);
    const [afterFailure] = await entries();
    expect(afterFailure).toMatchObject({ status: 'pending', retryCount: 1 });
    expect(afterFailure.lastRetryError).toContain('not sent: 421');

    failWith = null;
    await makeDue();
    await dlq.processAutoRetries();
    expect(sent).toHaveLength(1);
    expect(await entries()).toMatchObject([{ status: 'replayed' }]);
  });

  it('leaves an entry without an event to an admin instead of closing it', async () => {
    await withTenantContext(A, () =>
      dlqModel.create({
        tenantId: A,
        type: 'workflow_terminal',
        source: 'onboarding',
        originalPayload: { workflowId: 'wf-1' },
        error: { message: 'workflow failed' },
        retryCount: 0,
        maxRetries: 3,
        nextRetryAt: new Date(Date.now() - 1000),
        status: 'pending',
      }),
    );

    await dlq.processAutoRetries();

    expect(await entries()).toMatchObject([{ status: 'pending', retryCount: 0 }]);
  });
});
