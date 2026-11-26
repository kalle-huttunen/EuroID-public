import { OutboxPollerService } from './outbox-poller.service';

type MockQuery = {
  setOptions: jest.Mock;
  lean: jest.Mock;
  exec: jest.Mock;
};

function mockQuery(result: unknown): MockQuery {
  const q: MockQuery = {
    setOptions: jest.fn(() => q),
    lean: jest.fn(() => q),
    exec: jest.fn().mockResolvedValue(result),
  };
  return q;
}

type MockUpdate = {
  setOptions: jest.Mock;
  exec: jest.Mock;
};

function mockUpdate(): MockUpdate {
  const u: MockUpdate = {
    setOptions: jest.fn(() => u),
    exec: jest.fn().mockResolvedValue({ acknowledged: true }),
  };
  return u;
}

describe('OutboxPollerService.processPending', () => {
  let outboxModel: {
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
  };
  let emitter: { emitAsync: jest.Mock };
  let deadLetterService: { capture: jest.Mock };
  let config: { get: jest.Mock };
  let poller: OutboxPollerService;

  beforeEach(() => {
    outboxModel = {
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(() => mockUpdate()),
    };
    emitter = { emitAsync: jest.fn().mockResolvedValue([]) };
    deadLetterService = { capture: jest.fn() };
    config = {
      get: jest.fn((key: string) => {
        if (key === 'events.OUTBOX_POLLER_BATCH_SIZE') return 5;
        if (key === 'events.OUTBOX_POLL_INTERVAL_MS') return 2000;
        return undefined;
      }),
    };

    poller = new OutboxPollerService(
      outboxModel as any,
      emitter as any,
      deadLetterService as any,
      config as any,
    );
  });

  it('claims pending events in createdAt order (oldest first) and publishes via emitter', async () => {
    const doc = {
      _id: 'obj-1',
      eventId: 'evt-1',
      type: 'identity.created',
      aggregateId: 'user-1',
      payload: { identityId: 'user-1' },
      metadata: { correlationId: 'corr-1', tenantId: 't-1' },
      retryCount: 0,
      createdAt: new Date('2026-04-17T00:00:00Z'),
    };
    outboxModel.findOneAndUpdate
      .mockReturnValueOnce(mockQuery(doc))
      .mockReturnValueOnce(mockQuery(null));

    await poller.processPending();

    // Pending, or claimed longer ago than the timeout (outbox-poller.service.integration.spec.ts)
    expect(outboxModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        $or: [
          // A pending event whose retry is due (no nextAttemptAt: never failed)
          {
            status: 'pending',
            $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: expect.any(Date) } }],
          },
          { status: 'processing', claimedAt: { $lt: expect.any(Date) } },
          { status: 'processing', claimedAt: null, updatedAt: { $lt: expect.any(Date) } },
        ],
      },
      {
        $set: { status: 'processing', claimedAt: expect.any(Date), claimToken: expect.any(String) },
      },
      { sort: { createdAt: 1 }, new: true },
    );
    expect(emitter.emitAsync).toHaveBeenCalledTimes(1);
    const [type, event] = emitter.emitAsync.mock.calls[0];
    expect(type).toBe('identity.created');
    expect(event.eventId).toBe('evt-1');
    expect(event.payload).toEqual({ identityId: 'user-1' });
    // Only while this process still holds the claim (its token)
    expect(outboxModel.updateOne).toHaveBeenCalledWith(
      { _id: 'obj-1', claimToken: expect.any(String) },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'published',
          publishedAt: expect.any(Date),
          expireAt: expect.any(Date),
        }),
      }),
    );
  });

  it('returns event to pending and increments retryCount when handler throws (retryable)', async () => {
    const doc = {
      _id: 'obj-1',
      eventId: 'evt-1',
      type: 'identity.created',
      aggregateId: 'user-1',
      payload: { identityId: 'user-1' },
      metadata: { correlationId: 'corr-1', tenantId: 't-1' },
      retryCount: 1,
    };
    outboxModel.findOneAndUpdate
      .mockReturnValueOnce(mockQuery(doc))
      .mockReturnValueOnce(mockQuery(null));
    emitter.emitAsync.mockRejectedValueOnce(new Error('handler blew up'));

    const before = Date.now();
    await poller.processPending();

    // Back to pending with a backoff: the second failure waits 2 x OUTBOX_RETRY_BASE_MS (5 s)
    expect(outboxModel.updateOne).toHaveBeenCalledWith(
      { _id: 'obj-1', claimToken: expect.any(String) },
      { $set: { status: 'pending', nextAttemptAt: expect.any(Date) }, $inc: { retryCount: 1 } },
    );
    const nextAttemptAt: Date = outboxModel.updateOne.mock.calls[0][1].$set.nextAttemptAt;
    expect(nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 10_000);
    expect(nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 10_000);
    expect(deadLetterService.capture).not.toHaveBeenCalled();
  });

  it('marks event failed and captures to DLQ after MAX_RETRIES', async () => {
    const doc = {
      _id: 'obj-1',
      eventId: 'evt-1',
      type: 'identity.created',
      aggregateId: 'user-1',
      payload: { identityId: 'user-1' },
      metadata: { correlationId: 'corr-1', tenantId: 't-1' },
      retryCount: 4, // next retry will be 5 = MAX_RETRIES
    };
    outboxModel.findOneAndUpdate
      .mockReturnValueOnce(mockQuery(doc))
      .mockReturnValueOnce(mockQuery(null));
    emitter.emitAsync.mockRejectedValueOnce(new Error('permanent failure'));

    await poller.processPending();

    expect(outboxModel.updateOne).toHaveBeenCalledWith(
      { _id: 'obj-1', claimToken: expect.any(String) },
      { $set: { status: 'failed' }, $inc: { retryCount: 1 } },
    );
    expect(deadLetterService.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event_handler_failure',
        source: 'identity.created',
        correlationId: 'corr-1',
        tenantId: 't-1',
      }),
    );
  });

  it('stops claiming when no pending events remain (first findOneAndUpdate returns null)', async () => {
    outboxModel.findOneAndUpdate.mockReturnValueOnce(mockQuery(null));

    await poller.processPending();

    expect(emitter.emitAsync).not.toHaveBeenCalled();
    expect(outboxModel.updateOne).not.toHaveBeenCalled();
  });

  it('honors configured batch size (stops after N events even if more pending)', async () => {
    const mkDoc = (i: number) => ({
      _id: `obj-${i}`,
      eventId: `evt-${i}`,
      type: 'identity.created',
      aggregateId: `user-${i}`,
      payload: { identityId: `user-${i}` },
      metadata: { correlationId: 'corr', tenantId: 't-1' },
      retryCount: 0,
    });
    // Batch size is 5; return 5 pending docs (would claim 6+ if unbounded).
    for (let i = 0; i < 5; i++) {
      outboxModel.findOneAndUpdate.mockReturnValueOnce(mockQuery(mkDoc(i)));
    }
    // No extra call should happen beyond batch size.
    outboxModel.findOneAndUpdate.mockReturnValue(mockQuery(mkDoc(99)));

    await poller.processPending();

    expect(emitter.emitAsync).toHaveBeenCalledTimes(5);
    expect(outboxModel.findOneAndUpdate).toHaveBeenCalledTimes(5);
  });
});

describe('OutboxPollerService timers', () => {
  const stream = () => ({ on: jest.fn(), close: jest.fn().mockResolvedValue(undefined) });

  afterEach(() => {
    jest.useRealTimers();
  });

  // With change streams only a later change used to start a poll, so a claim left by a stopped
  // process, or an event whose retry was due, waited for the next unrelated event.
  it('sweeps every OUTBOX_SWEEP_INTERVAL_MS while it uses change streams', async () => {
    jest.useFakeTimers();
    const findOneAndUpdate = jest.fn(() => mockQuery(null));
    const settings: Record<string, number> = {
      'events.OUTBOX_POLL_INTERVAL_MS': 2000,
      'events.OUTBOX_SWEEP_INTERVAL_MS': 15000,
    };
    const poller = new OutboxPollerService(
      { findOneAndUpdate, watch: jest.fn(stream) } as any,
      { emitAsync: jest.fn() } as any,
      { capture: jest.fn() } as any,
      { get: (key: string) => settings[key] } as any,
    );

    await poller.onModuleInit();
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1); // the start-up pass

    await jest.advanceTimersByTimeAsync(14_999);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(3);

    await poller.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(3);
  });
});
