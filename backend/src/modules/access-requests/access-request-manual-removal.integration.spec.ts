/**
 * Closing an ACTIVE access request whose removal keeps failing as removed by hand (HX-E3,
 * AccessRequestManualRemovalService; in-memory MongoDB, tenant plugin). Before, a removal Entra
 * ID refused for good was retried every 6 hours forever and nothing could close the request
 * (HX-E2 follow-up). Now:
 *   - the request ends EXPIRED with the admin, when, their note and the failure it closes
 *     (`removedManually`), the note on the request page (`statusReason`), audited as
 *     access_request.closed with the admin as actor, and the run gets REMOVED_MANUALLY;
 *   - a run that no longer exists leaves the request closed; a run Temporal cannot reach puts
 *     the request back as it was (ACTIVE, its failure reason) and answers 503;
 *   - only an ACTIVE request past its end date can be closed (409 otherwise), only in the tenant.
 */
import mongoose, { Model } from 'mongoose';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ServiceError, WorkflowNotFoundError } from '@temporalio/client';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { DomainEventType } from '@infrastructure/events/event-types';
import { connectTestDb, clearTestDb, closeTestDb, withTestTenant, TEST_TENANT_ID } from '@testing';
import {
  AccessRequest,
  AccessRequestSchema,
  type AccessRequestDocument,
  type AccessRequestStatus,
} from './schemas/access-request.schema';
import {
  AccessRequestManualRemovalService,
  REMOVAL_NOT_DELIVERED_MESSAGE,
} from './access-request-manual-removal.service';

mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof AccessRequestManualRemovalService>;

const ADMIN = 'pat.policy@example.com';
const DAY_MS = 86_400_000;
const FAILURE = 'Entra ID refused to remove the access: entra-id: 1 of 1 changes failed.';
const NOTE = 'Removed from the Finance group in the Entra admin center on 26.11.';

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => Promise.resolve(withTestTenant(fn));

describe('Closing an access request as removed by hand (MongoDB)', () => {
  let model: Model<AccessRequestDocument>;
  let service: AccessRequestManualRemovalService;
  const events = { emit: jest.fn() };
  const signal = jest.fn();
  const getHandle = jest.fn(() => ({ signal }));
  const temporal = { getClient: () => ({ workflow: { getHandle } }) };

  const stored = () => model.collection.findOne({ requestId: 'req-1' });

  const seed = (
    status: AccessRequestStatus = 'ACTIVE',
    fields: Record<string, unknown> = {},
    tenantId = TEST_TENANT_ID,
  ) =>
    model.collection.insertOne({
      tenantId,
      requestId: 'req-1',
      requesterId: 'id-requester',
      requesterEmail: 'requester@example.com',
      entitlements: [],
      approvalSteps: [],
      status,
      workflowId: 'access-request-req-1',
      expiresAt: new Date(Date.now() - DAY_MS),
      statusReason: FAILURE,
      ...fields,
    });

  const close = (note = NOTE) => inTenant(() => service.markRemovedManually('req-1', ADMIN, note));

  beforeAll(async () => {
    await connectTestDb();
    model = mongoose.model(
      AccessRequest.name,
      AccessRequestSchema,
    ) as unknown as Model<AccessRequestDocument>;
    service = new AccessRequestManualRemovalService(
      model as unknown as Ctor[0],
      temporal as unknown as Ctor[1],
      events as unknown as Ctor[2],
    );
  });

  beforeEach(() => {
    events.emit.mockReset();
    signal.mockReset().mockResolvedValue(undefined);
    getHandle.mockClear();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('closes the request EXPIRED with the admin and their note, audited, and stops the run', async () => {
    await seed();

    const closed = await close();

    expect(closed.status).toBe('EXPIRED');
    const doc = await stored();
    expect(doc).toMatchObject({
      status: 'EXPIRED',
      statusReason: `An admin removed the access by hand and closed the request: ${NOTE}`,
      removedManually: { by: ADMIN, at: expect.any(Date), note: NOTE, failureReason: FAILURE },
    });
    expect(getHandle).toHaveBeenCalledWith('access-request-req-1');
    expect(signal).toHaveBeenCalledWith('REMOVED_MANUALLY');
    expect(events.emit).toHaveBeenCalledWith(
      DomainEventType.ACCESS_REQUEST_CLOSED,
      'req-1',
      { requestId: 'req-1', status: 'EXPIRED', reason: NOTE, removedManually: true },
      { actor: ADMIN },
    );
  });

  it('leaves the request closed when its run no longer exists', async () => {
    await seed();
    signal.mockRejectedValue(new WorkflowNotFoundError('gone', 'access-request-req-1', ''));

    await expect(close()).resolves.toMatchObject({ status: 'EXPIRED' });
    expect((await stored())!.status).toBe('EXPIRED');
    expect(events.emit).toHaveBeenCalled();
  });

  it('puts the request back as it was and answers 503 when Temporal cannot be reached', async () => {
    await seed();
    signal.mockRejectedValue(
      new ServiceError('Failed to signal Workflow', { cause: new Error('14 UNAVAILABLE') }),
    );

    const error = await close().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe(REMOVAL_NOT_DELIVERED_MESSAGE);
    const doc = await stored();
    expect(doc).toMatchObject({ status: 'ACTIVE', statusReason: FAILURE });
    expect(doc!.removedManually).toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('puts back a request that had no reason without one', async () => {
    await seed('ACTIVE', { statusReason: undefined });
    signal.mockRejectedValue(new ServiceError('Failed to signal Workflow'));

    await expect(close()).rejects.toBeInstanceOf(ServiceUnavailableException);
    const doc = await stored();
    expect(doc!.status).toBe('ACTIVE');
    expect(doc!.statusReason ?? undefined).toBeUndefined();
  });

  it.each<[string, AccessRequestStatus, Record<string, unknown>]>([
    ['a request that is not ACTIVE', 'PENDING_APPROVAL', {}],
    ['an EXPIRED request', 'EXPIRED', {}],
    [
      'an ACTIVE request before its end date',
      'ACTIVE',
      { expiresAt: new Date(Date.now() + DAY_MS) },
    ],
    ['an ACTIVE request with no end date', 'ACTIVE', { expiresAt: undefined }],
  ])('refuses (409) %s and changes nothing', async (_label, status, fields) => {
    await seed(status, fields);

    await expect(close()).rejects.toBeInstanceOf(ConflictException);
    expect((await stored())!.status).toBe(status);
    expect(signal).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('takes the requested end date when the request stored no granted one', async () => {
    await seed('ACTIVE', {
      expiresAt: undefined,
      timeConstraint: { expiresAt: new Date(Date.now() - DAY_MS) },
    });

    await expect(close()).resolves.toMatchObject({ status: 'EXPIRED' });
  });

  it('answers 404 for a request of another tenant', async () => {
    await seed('ACTIVE', {}, 'other-tenant');

    await expect(close()).rejects.toBeInstanceOf(NotFoundException);
    expect(signal).not.toHaveBeenCalled();
  });
});
