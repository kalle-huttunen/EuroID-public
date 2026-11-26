/**
 * Who re-runs a dead-letter entry (2.0dl). In-memory MongoDB with the tenant plugin, the real
 * DeadLetterService and handler registry; the entries name a registered probe handler.
 *
 * Before 2.0dl: retryEntry set `retrying` without looking at the state it read, and the automatic
 * retry picked `retrying` entries too. Every API replica and every worker runs that poller, so two
 * processes polling at once re-ran the same entry, an admin's retry re-ran an entry the poller was
 * running, and the outcome written last won (an entry dismissed meanwhile was reopened as
 * replayed). A retry whose process stopped left the entry `retrying` with nothing counted.
 */
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { DeadLetterService } from './dead-letter.service';
import { DeadLetterHandlerRegistry } from './dead-letter-handler.registry';
import {
  DeadLetterEntry,
  DeadLetterEntryDocument,
  DeadLetterEntrySchema,
} from './schemas/dead-letter.schema';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const PROBE = 'ProbeHandler.handle';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (ms: number) => new Date(Date.now() - ms);

/** A promise the test settles itself: a handler still running. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Dead-letter retries: one process re-runs an entry (MongoDB)', () => {
  let moduleRef: TestingModule;
  let dlq: DeadLetterService;
  let model: Model<DeadLetterEntryDocument>;
  const probe = jest.fn<Promise<void>, [unknown]>();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: DeadLetterEntry.name, schema: DeadLetterEntrySchema }]),
      ],
      providers: [
        DeadLetterService,
        DeadLetterHandlerRegistry,
        { provide: EventEmitter2, useValue: { emitAsync: jest.fn().mockResolvedValue([]) } },
        // Defaults: DLQ_MAX_RETRIES 3, a five-minute lease (the test runs the polls itself).
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PluginRegistryService, useValue: { getSecretConfigKeys: () => null } },
      ],
    }).compile();
    await moduleRef.init();

    dlq = moduleRef.get(DeadLetterService);
    model = moduleRef.get(getModelToken(DeadLetterEntry.name));
    moduleRef.get(DeadLetterHandlerRegistry).register(PROBE, (event) => probe(event));
  });

  beforeEach(() => {
    probe.mockReset();
    probe.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await model.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /** A handler failure whose automatic retry is due (by default). */
  const entry = (overrides: Record<string, unknown> = {}) =>
    model.create({
      tenantId: A,
      type: 'event_handler_failure',
      source: 'identity.created',
      handler: PROBE,
      originalPayload: {
        eventId: 'evt-1',
        type: 'identity.created',
        aggregateId: 'id-1',
        payload: { identityId: 'id-1' },
        metadata: { tenantId: A, depth: 0 },
      },
      error: { message: 'timeline write failed' },
      retryCount: 0,
      maxRetries: 3,
      nextRetryAt: ago(1000),
      status: 'pending',
      ...overrides,
    });
  const stored = async (id: unknown) =>
    model.findById(id).setOptions({ skipTenantScope: true }).lean().exec();
  const asAdmin = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;

  /**
   * dismiss was an unconditional findByIdAndUpdate: it could dismiss an entry already replayed,
   * overwriting who closed it and when (hunt 09 note, r2-05 N13).
   */
  describe('dismiss', () => {
    it.each(['pending', 'retrying', 'failed_permanently'])(
      'dismisses an open (%s) entry and records who did',
      async (status) => {
        const open = await entry({ status });

        await asAdmin(() => dlq.dismiss(String(open._id), 'ops@a.example'));

        expect(await stored(open._id)).toMatchObject({
          status: 'dismissed',
          resolvedBy: 'ops@a.example',
        });
      },
    );

    it.each(['replayed', 'dismissed'])(
      'refuses a %s entry with 409 and keeps who closed it',
      async (status) => {
        const closedAt = ago(60_000);
        const closed = await entry({ status, resolvedBy: 'first@a.example', resolvedAt: closedAt });

        const answer = asAdmin(() => dlq.dismiss(String(closed._id), 'ops@a.example'));

        await expect(answer).rejects.toThrow(ConflictException);
        await expect(answer).rejects.toThrow(`is ${status}`);
        expect(await stored(closed._id)).toMatchObject({
          status,
          resolvedBy: 'first@a.example',
          resolvedAt: closedAt,
        });
      },
    );
  });

  it('runs a due entry once when two processes poll at the same time', async () => {
    const due = await entry();
    probe.mockImplementation(async () => {
      await tick(20); // the handler takes a moment: both polls are under way
    });

    const processed = await Promise.all([dlq.processAutoRetries(), dlq.processAutoRetries()]);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(processed.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await stored(due._id)).toMatchObject({ status: 'replayed', retryCount: 0 });
  });

  it("refuses an admin's retry with 409 while the automatic retry runs the entry", async () => {
    const due = await entry();
    const running = deferred();
    probe.mockImplementationOnce(() => running.promise);

    const poll = dlq.processAutoRetries();
    for (let i = 0; i < 50 && probe.mock.calls.length === 0; i++) await tick();

    const admin = asAdmin(() => dlq.retryEntry(String(due._id), 'admin@a.example'));
    await expect(admin).rejects.toThrow(ConflictException);
    await expect(admin).rejects.toThrow(/being retried/);

    running.resolve();
    await poll;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await stored(due._id)).toMatchObject({
      status: 'replayed',
      resolvedBy: 'auto-retry-poller',
    });
  });

  it('takes a retry whose process stopped again after its lease, counting the stopped run', async () => {
    const stopped = await entry({ status: 'retrying', retryCount: 0 });
    probe.mockRejectedValue(new Error('timeline still down'));

    await dlq.processAutoRetries();

    expect(probe).toHaveBeenCalledTimes(1);
    const after = await stored(stopped._id);
    expect(after).toMatchObject({ status: 'pending', retryCount: 2 });
    expect(after?.lastRetryError).toBe('timeline still down');
    expect(after?.nextRetryAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('closes a stopped retry as failed for good when it was the last one allowed', async () => {
    const stopped = await entry({ status: 'retrying', retryCount: 2 });

    await dlq.processAutoRetries();

    expect(probe).not.toHaveBeenCalled();
    const after = await stored(stopped._id);
    expect(after).toMatchObject({ status: 'failed_permanently', retryCount: 3 });
    expect(after?.lastRetryError).toMatch(/did not finish/);
  });

  it('leaves a retry whose lease still runs to the process running it', async () => {
    const running = await entry({ status: 'retrying', nextRetryAt: new Date(Date.now() + 60_000) });

    await dlq.processAutoRetries();
    await expect(asAdmin(() => dlq.retryEntry(String(running._id), 'admin'))).rejects.toThrow(
      /being retried/,
    );

    expect(probe).not.toHaveBeenCalled();
    expect(await stored(running._id)).toMatchObject({ status: 'retrying', retryCount: 0 });
  });

  it('keeps an entry dismissed while its retry ran dismissed', async () => {
    const due = await entry();
    const running = deferred();
    probe.mockImplementationOnce(() => running.promise);

    const poll = dlq.processAutoRetries();
    for (let i = 0; i < 50 && probe.mock.calls.length === 0; i++) await tick();
    await asAdmin(() => dlq.dismiss(String(due._id), 'admin@a.example'));
    running.resolve();
    await poll;

    expect(await stored(due._id)).toMatchObject({
      status: 'dismissed',
      resolvedBy: 'admin@a.example',
    });
  });

  it('runs a replay once while the automatic retry polls, and leaves a failed one pending as it was', async () => {
    const due = await entry({ retryCount: 1 });
    const before = await stored(due._id);
    const running = deferred();
    probe.mockImplementationOnce(() => running.promise);

    const replay = asAdmin(() => dlq.replay(String(due._id), 'admin@a.example'));
    for (let i = 0; i < 50 && probe.mock.calls.length === 0; i++) await tick();
    await dlq.processAutoRetries();
    running.reject(new Error('timeline still down'));

    await expect(replay).resolves.toMatchObject({ status: 'pending', retryCount: 1 });
    expect(probe).toHaveBeenCalledTimes(1);
    const after = await stored(due._id);
    expect(after).toMatchObject({
      status: 'pending',
      retryCount: 1,
      lastRetryError: 'timeline still down',
    });
    expect(after?.nextRetryAt?.getTime()).toBe(before?.nextRetryAt?.getTime());
  });
});
