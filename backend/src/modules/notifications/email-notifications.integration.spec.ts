/**
 * Email notifications end to end below the event bus (in-memory MongoDB with the tenant plugin,
 * nodemailer's JSON transport instead of an SMTP server): who gets a mail, inside which tenant,
 * that the same notification is sent once, that a failed send reaches the dead-letter queue with
 * no address or content, and that the DLQ retry sends it. The identity directory is a stub that
 * answers from the tenant context, like IdentityQueryService.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { createTransport } from 'nodemailer';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { type MailConfig, mailConfig } from '@infrastructure/config/mail.config';
import { DomainEventType } from '@infrastructure/events/event-types';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { AdminUser, AdminUserSchema, AdminUserDocument } from '../auth/schemas/admin-user.schema';
import {
  EmailNotification,
  EmailNotificationSchema,
  EmailNotificationDocument,
} from './schemas/email-notification.schema';
import { MAIL_SENDER, MailTransportService, type OutgoingMail } from './mail-transport.service';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailRecipientsService } from './email-recipients.service';
import { EmailNotificationService, type ApproverNotice } from './email-notification.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const IDENTITY_A = '64b000000000000000000001';
const IDENTITY_B = '64b000000000000000000002';

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

interface SentMail {
  to: Array<{ address: string }>;
  subject: string;
  text: string;
  html: string;
}

const APPROVAL: ApproverNotice = {
  requestId: 'req-1',
  stepIndex: 0,
  stepCount: 2,
  approverEmail: 'manager@a.example',
  requesterId: 'requester-id',
  requesterEmail: 'requester@a.example',
  entitlements: [{ system: 'entra-id', name: 'Sales Team' }],
};

describe('Email notifications (MongoDB, JSON transport)', () => {
  let moduleRef: TestingModule;
  let notifications: EmailNotificationService;
  let delivery: EmailDeliveryService;
  let model: Model<EmailNotificationDocument>;

  const sent: SentMail[] = [];
  let failWith: Error | null = null;
  const json = createTransport({ jsonTransport: true });
  const sender = {
    sendMail: async (message: OutgoingMail & { from: string }) => {
      if (failWith) throw failWith;
      const info = await json.sendMail(message);
      sent.push(JSON.parse(info.message) as SentMail);
      return info;
    },
  };
  const deadLetter = { capture: jest.fn().mockResolvedValue(undefined) };

  const directory: Record<string, Array<{ _id: string; email: string }>> = {
    [A]: [
      { _id: IDENTITY_A, email: 'owner@a.example' },
      { _id: '64b0000000000000000000a3', email: 'reviewer@a.example' },
    ],
    [B]: [{ _id: IDENTITY_B, email: 'owner@b.example' }],
  };
  const inContextTenant = () => directory[requestContext.getStore()?.tenantId ?? ''] ?? [];
  const identities = {
    findByEmail: jest.fn(
      async (email: string) => inContextTenant().find((i) => i.email === email) ?? null,
    ),
    findById: jest.fn(async (id: string) => inContextTenant().find((i) => i._id === id) ?? null),
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: EmailNotification.name, schema: EmailNotificationSchema },
          { name: AdminUser.name, schema: AdminUserSchema },
        ]),
      ],
      providers: [
        MailTransportService,
        EmailDeliveryService,
        EmailRecipientsService,
        EmailNotificationService,
        { provide: mailConfig.KEY, useValue: CONF },
        { provide: MAIL_SENDER, useValue: sender },
        { provide: DeadLetterService, useValue: deadLetter },
        { provide: IDENTITY_QUERY_PORT, useValue: identities },
      ],
    }).compile();
    notifications = moduleRef.get(EmailNotificationService);
    delivery = moduleRef.get(EmailDeliveryService);
    model = moduleRef.get(getModelToken(EmailNotification.name));
    await model.init(); // the unique (tenantId, dedupeKey) index must exist before the first insert

    const admins = moduleRef.get<Model<AdminUserDocument>>(getModelToken(AdminUser.name));
    await admins.create([
      { email: 'manager@a.example', passwordHash: 'x', name: 'Manager A', tenantId: A },
      { email: 'boss@b.example', passwordHash: 'x', name: 'Boss B', tenantId: B },
      { email: 'gone@a.example', passwordHash: 'x', name: 'Gone A', tenantId: A, isActive: false },
      // ROLE approval step holders
      {
        email: 'pa2@a.example',
        passwordHash: 'x',
        name: 'PA 2',
        tenantId: A,
        role: 'policy-admin',
      },
      {
        email: 'pa1@a.example',
        passwordHash: 'x',
        name: 'PA 1',
        tenantId: A,
        role: 'policy-admin',
      },
      {
        email: 'pa-gone@a.example',
        passwordHash: 'x',
        name: 'PA gone',
        tenantId: A,
        role: 'policy-admin',
        isActive: false,
      },
      { email: 'pa@b.example', passwordHash: 'x', name: 'PA B', tenantId: B, role: 'policy-admin' },
      {
        email: 'requester@a.example',
        passwordHash: 'x',
        name: 'Req',
        tenantId: A,
        role: 'policy-admin',
      },
      {
        email: 'ca@a.example',
        passwordHash: 'x',
        name: 'CA',
        tenantId: A,
        role: 'connector-admin',
      },
    ]);
  });

  afterEach(async () => {
    await model.deleteMany({}).setOptions({ skipTenantScope: true });
    sent.length = 0;
    failWith = null;
    deadLetter.capture.mockClear();
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const stored = () => model.find({}).setOptions({ skipTenantScope: true }).lean().exec();

  it('mails the approver once and keeps only a sent record (bodies dropped)', async () => {
    await expect(notifications.notifyApprover(A, APPROVAL)).resolves.toBe('sent');

    expect(sent).toHaveLength(1);
    expect(sent[0].to[0].address).toBe('manager@a.example');
    expect(sent[0].text).toContain('https://euroid.example/access-requests/req-1');
    expect(sent[0].text).not.toContain('requester@a.example');
    const [doc] = await stored();
    expect(doc).toMatchObject({
      tenantId: A,
      kind: 'approval-requested',
      status: 'SENT',
      attempts: 1,
    });
    expect(doc.sentAt).toBeInstanceOf(Date);
    expect(doc.text).toBeUndefined();
    expect(doc.html).toBeUndefined();
  });

  it('sends the same notification only once (retried activity, hourly expiry run)', async () => {
    await notifications.notifyApprover(A, APPROVAL);
    await expect(notifications.notifyApprover(A, APPROVAL)).resolves.toBe('duplicate');

    const expiring = {
      identityId: IDENTITY_A,
      targetSystem: 'entra-id',
      expiresAt: new Date('2026-11-29T10:00:00Z'),
      window: 'soon' as const,
    };
    await expect(notifications.notifyAccessExpiring(A, expiring)).resolves.toBe('sent');
    await expect(notifications.notifyAccessExpiring(A, expiring)).resolves.toBe('duplicate');
    await expect(
      notifications.notifyAccessExpiring(A, { ...expiring, window: 'tomorrow' }),
    ).resolves.toBe('sent');

    expect(sent.map((m) => m.to[0].address)).toEqual([
      'manager@a.example',
      'owner@a.example',
      'owner@a.example',
    ]);
  });

  it('resolves recipients inside the tenant only', async () => {
    const review = { campaignId: 'c1', campaignName: 'Q4', itemCount: 2 };
    await expect(
      notifications.notifyReviewer(A, { ...review, reviewerKey: 'boss@b.example' }),
    ).resolves.toBe('no-recipient');
    await expect(
      notifications.notifyReviewer(A, { ...review, reviewerKey: 'owner@b.example' }),
    ).resolves.toBe('no-recipient');
    await expect(
      notifications.notifyAccessExpiring(A, {
        identityId: IDENTITY_B,
        targetSystem: 'scim',
        expiresAt: '2026-11-23T00:00:00Z',
        window: 'tomorrow',
      }),
    ).resolves.toBe('no-recipient');
    expect(sent).toHaveLength(0);

    await expect(
      notifications.notifyReviewer(B, { ...review, reviewerKey: 'boss@b.example' }),
    ).resolves.toBe('sent');
    await expect(
      notifications.notifyReviewer(A, { ...review, reviewerKey: 'reviewer@a.example' }),
    ).resolves.toBe('sent');
    expect(sent.map((m) => m.to[0].address)).toEqual(['boss@b.example', 'reviewer@a.example']);
  });

  it('mails nobody for a role name, the placeholder reviewer, an inactive admin or the requester', async () => {
    await expect(
      notifications.notifyApprover(A, {
        ...APPROVAL,
        approverEmail: 'policy-admin',
        approverId: 'policy-admin',
      }),
    ).resolves.toBe('no-recipient');
    await expect(
      notifications.notifyReviewer(A, {
        campaignId: 'c1',
        campaignName: 'Q4',
        itemCount: 1,
        reviewerKey: 'unassigned@review.pending',
      }),
    ).resolves.toBe('no-recipient');
    await expect(
      notifications.notifyApprover(A, { ...APPROVAL, approverEmail: 'gone@a.example' }),
    ).resolves.toBe('no-recipient');
    await expect(
      notifications.notifyApprover(A, {
        ...APPROVAL,
        approverEmail: 'reviewer@a.example',
        requesterEmail: 'reviewer@a.example',
      }),
    ).resolves.toBe('self');
    expect(sent).toHaveLength(0);
    expect(await stored()).toHaveLength(0);
  });

  it('mails every active holder of the role of a ROLE step in the tenant, not the requester', async () => {
    const roleStep: ApproverNotice = {
      ...APPROVAL,
      approverEmail: 'policy-admin',
      approverId: 'policy-admin',
      approverRole: 'policy-admin',
    };
    await expect(notifications.notifyApprover(A, roleStep)).resolves.toBe('sent');
    expect(sent.map((m) => m.to[0].address)).toEqual(['pa1@a.example', 'pa2@a.example']);
    expect(sent[0].text).toContain('https://euroid.example/access-requests/req-1');

    // Retried activity: nobody is mailed twice
    await expect(notifications.notifyApprover(A, roleStep)).resolves.toBe('duplicate');
    expect(sent).toHaveLength(2);
  });

  it('mails nobody for a ROLE step whose role only the requester or nobody holds', async () => {
    await expect(
      notifications.notifyApprover(A, {
        ...APPROVAL,
        approverRole: 'connector-admin',
        requesterEmail: 'ca@a.example',
      }),
    ).resolves.toBe('self');
    await expect(
      notifications.notifyApprover(A, { ...APPROVAL, approverRole: 'super-admin' }),
    ).resolves.toBe('no-recipient');
    expect(sent).toHaveLength(0);
    expect(await stored()).toHaveLength(0);
  });

  it('puts a failed send in the dead-letter queue with only the notification id', async () => {
    failWith = new Error('550 5.1.1 <manager@a.example>: Recipient address rejected');

    await expect(notifications.notifyApprover(A, APPROVAL)).resolves.toBe('failed');

    const [doc] = await stored();
    expect(doc.status).toBe('FAILED');
    expect(doc.lastError).not.toContain('manager@a.example');
    expect(doc.lastError).toContain('m•••@a.example');
    expect(deadLetter.capture).toHaveBeenCalledTimes(1);
    const entry = deadLetter.capture.mock.calls[0][0];
    expect(entry).toMatchObject({
      type: 'event_handler_failure',
      source: 'email:approval-requested',
      tenantId: A,
      originalPayload: {
        type: DomainEventType.EMAIL_NOTIFICATION_RETRY,
        aggregateId: String(doc._id),
        payload: { notificationId: String(doc._id), kind: 'approval-requested' },
        metadata: { tenantId: A },
      },
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('manager@a.example');
    expect(serialized).not.toContain('Sales Team');
  });

  it('the dead-letter retry sends it, then reports it already sent', async () => {
    failWith = new Error('421 service not available');
    await notifications.notifyApprover(A, APPROVAL);
    const [doc] = await stored();

    failWith = new Error('421 still not available');
    await expect(delivery.redeliver(A, String(doc._id))).rejects.toThrow(/not sent: 421/);
    expect((await stored())[0].attempts).toBe(2);

    failWith = null;
    await expect(delivery.redeliver(A, String(doc._id))).resolves.toBe('sent');
    await expect(delivery.redeliver(A, String(doc._id))).resolves.toBe('already-sent');
    expect(sent).toHaveLength(1);
  });

  it('a retry under another tenant finds nothing to send', async () => {
    failWith = new Error('421 service not available');
    await notifications.notifyApprover(A, APPROVAL);
    const [doc] = await stored();
    failWith = null;

    await expect(delivery.redeliver(B, String(doc._id))).rejects.toThrow(/no longer exists/);
    expect(sent).toHaveLength(0);
  });

  it('leaves a send in progress alone, but takes over one that went stale', async () => {
    const [doc] = await model.create([
      {
        tenantId: A,
        kind: 'review-assigned',
        dedupeKey: 'review-assigned:c9:reviewer@a.example',
        to: 'reviewer@a.example',
        subject: 'Access review',
        text: 'text',
        html: '<p>html</p>',
        status: 'SENDING',
        attempts: 1,
        claimedAt: new Date(),
      },
    ]);
    await expect(delivery.redeliver(A, String(doc._id))).resolves.toBe('in-progress');
    expect(sent).toHaveLength(0);

    await model
      .updateOne(
        { _id: doc._id, tenantId: A },
        { $set: { claimedAt: new Date(Date.now() - 60_000) } },
      )
      .exec();
    await expect(delivery.redeliver(A, String(doc._id))).resolves.toBe('sent');
    expect(sent).toHaveLength(1);
  });

  // A reconciliation run reached its drift thresholds and named notifyEmail (activity
  // notifyDriftThresholdExceeded): one mail per run and recipient, counts only, to a user of the
  // run's tenant and nobody else.
  it('mails the drift alert once per run to a user of the tenant, nobody outside it', async () => {
    const alert = {
      runId: 'run-1',
      recipientKey: 'manager@a.example',
      totalDrifts: 12,
      criticalDrifts: 5,
      alerts: [
        { threshold: 'maxDriftsBeforeAlert' as const, limit: 10, found: 12 },
        { threshold: 'criticalDriftAlertThreshold' as const, limit: 5, found: 5 },
      ],
    };

    await expect(notifications.notifyDriftThreshold(A, alert)).resolves.toBe('sent');
    await expect(notifications.notifyDriftThreshold(A, alert)).resolves.toBe('duplicate');
    await expect(
      notifications.notifyDriftThreshold(A, { ...alert, recipientKey: 'boss@b.example' }),
    ).resolves.toBe('no-recipient');

    expect(sent).toHaveLength(1);
    expect(sent[0].to[0].address).toBe('manager@a.example');
    expect(sent[0].subject).toBe('Reconciliation found 12 drifts (5 critical)');
    expect(sent[0].text).toContain('It found 12 drifts; the alert threshold is 10.');
    expect(sent[0].text).toContain('It found 5 critical drifts; the alert threshold is 5.');
    expect(sent[0].text).toContain('https://euroid.example/reconciliation');
    const [doc] = await stored();
    expect(doc).toMatchObject({ tenantId: A, kind: 'drift-threshold-exceeded', status: 'SENT' });
  });

  it('stores and sends nothing when email is off', async () => {
    const off = new MailTransportService({ ...CONF, enabled: false });
    const offDelivery = new EmailDeliveryService(
      model,
      off,
      deadLetter as unknown as DeadLetterService,
      CONF,
    );
    await expect(
      offDelivery.dispatch(A, {
        kind: 'review-assigned',
        dedupeKey: 'k',
        to: 'reviewer@a.example',
        subject: 's',
        text: 't',
        html: 'h',
      }),
    ).resolves.toBe('disabled');
    expect(await stored()).toHaveLength(0);
  });
});
