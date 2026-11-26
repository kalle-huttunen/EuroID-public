/**
 * The worker's schedules (worker.ts) were created once: "already exists" was logged and nothing
 * else happened. The server keeps the action args encoded as at creation, so after a key
 * rotation removed ENCRYPTION_KEY_PREVIOUS every scheduled run failed to decrypt its input, and a
 * changed cron env var (RECERTIFICATION_CRON and the like) never reached the schedule. On each
 * worker start upsertSchedule now updates an existing schedule: its spec and action are written
 * again, so the args are encoded by the client's data converter under the current key.
 */
import { ScheduleAlreadyRunning, ScheduleNotFoundError } from '@temporalio/client';
import type { ScheduleClient, ScheduleDescription, ScheduleOptions } from '@temporalio/client';
import { TemporalPayloadDecryptionError } from './temporal-payload-codec';
import { syncOptionalSchedule, upsertSchedule } from './schedule-upsert';

const options = (cron: string): ScheduleOptions => ({
  scheduleId: 'risk-score-calculation-daily',
  spec: { cronExpressions: [cron] },
  action: {
    type: 'startWorkflow',
    workflowType: 'riskScoreCalculationWorkflow',
    args: [{}],
    taskQueue: 'provisioning',
  },
});

/** A schedule as the server describes it: created under an older cron, paused with a note. */
const stored = {
  scheduleId: 'risk-score-calculation-daily',
  spec: { calendars: [{ hour: 2 }] },
  action: {
    type: 'startWorkflow',
    workflowType: 'riskScoreCalculationWorkflow',
    args: [{}],
    taskQueue: 'provisioning',
  },
  policies: { overlap: 'SKIP', catchupWindow: 60_000, pauseOnFailure: false },
  state: { paused: true, note: 'paused for maintenance' },
} as unknown as ScheduleDescription;

function fakeClient() {
  const handle = {
    update: jest.fn(async (fn: (previous: ScheduleDescription) => unknown) => {
      handle.updated = fn(stored);
    }),
    delete: jest.fn().mockResolvedValue(undefined),
    updated: undefined as unknown,
  };
  const client = {
    create: jest.fn(),
    getHandle: jest.fn(() => handle),
  };
  return { client, handle, schedule: client as unknown as ScheduleClient };
}

const logger = { log: jest.fn(), warn: jest.fn() };

describe('upsertSchedule', () => {
  beforeEach(() => {
    logger.log.mockClear();
    logger.warn.mockClear();
  });

  it('creates a schedule that does not exist', async () => {
    const { client, handle, schedule } = fakeClient();
    client.create.mockResolvedValue(undefined);

    expect(await upsertSchedule(schedule, options('0 2 * * *'), logger)).toBe('created');
    expect(client.create).toHaveBeenCalledWith(options('0 2 * * *'));
    expect(handle.update).not.toHaveBeenCalled();
  });

  it("rewrites an existing schedule's spec and action, keeping its policies and paused state", async () => {
    const { client, handle, schedule } = fakeClient();
    client.create.mockRejectedValue(
      new ScheduleAlreadyRunning(
        'Schedule already exists and is running',
        'risk-score-calculation-daily',
      ),
    );

    expect(await upsertSchedule(schedule, options('30 1 * * *'), logger)).toBe('updated');
    expect(client.getHandle).toHaveBeenCalledWith('risk-score-calculation-daily');
    // The new cron and the action args, which the client encodes again under the current key
    expect(handle.updated).toEqual({
      ...stored,
      spec: { cronExpressions: ['30 1 * * *'] },
      action: options('30 1 * * *').action,
    });
    expect(handle.updated).toMatchObject({
      state: { paused: true, note: 'paused for maintenance' },
    });
  });

  it('recreates a schedule whose stored args no key in the settings decrypts', async () => {
    const { client, handle, schedule } = fakeClient();
    client.create
      .mockRejectedValueOnce(
        new ScheduleAlreadyRunning('Schedule already exists and is running', 'x'),
      )
      .mockResolvedValueOnce(undefined);
    handle.update.mockRejectedValue(
      new TemporalPayloadDecryptionError('key-old', 'has no key under its id'),
    );

    expect(await upsertSchedule(schedule, options('0 2 * * *'), logger)).toBe('recreated');
    expect(handle.delete).toHaveBeenCalled();
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('key-old'));
  });

  // Final review AU6: workers starting at once both reach the delete and create; the second one
  // logged 'failed' although the schedule did end up recreated
  it('treats a schedule another worker deleted or recreated meanwhile as recreated', async () => {
    const { client, handle, schedule } = fakeClient();
    const exists = () => new ScheduleAlreadyRunning('Schedule already exists and is running', 'x');
    handle.update.mockRejectedValue(
      new TemporalPayloadDecryptionError('key-old', 'has no key under its id'),
    );

    // The other worker deleted it first: ours finds none to delete and creates it
    client.create.mockRejectedValueOnce(exists()).mockResolvedValueOnce(undefined);
    handle.delete.mockRejectedValueOnce(new ScheduleNotFoundError('not found', 'x'));
    expect(await upsertSchedule(schedule, options('0 2 * * *'), logger)).toBe('recreated');

    // The other worker created it again first: ours finds it there
    client.create.mockRejectedValueOnce(exists()).mockRejectedValueOnce(exists());
    expect(await upsertSchedule(schedule, options('0 2 * * *'), logger)).toBe('recreated');

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Could not recreate'));
  });

  it('logs a schedule it cannot create or update and lets the worker start', async () => {
    const { client, handle, schedule } = fakeClient();
    client.create.mockRejectedValueOnce(new ScheduleAlreadyRunning('exists', 'x'));
    handle.update.mockRejectedValue(new Error('PERMISSION_DENIED'));

    expect(await upsertSchedule(schedule, options('0 2 * * *'), logger)).toBe('failed');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('PERMISSION_DENIED'));

    client.create.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    expect(await upsertSchedule(schedule, options('0 2 * * *'), logger)).toBe('failed');
  });
});

/**
 * A job turned off (AUDIT_ARCHIVE_ENABLED, ARCHIVAL_ENABLED) kept its schedule running: the
 * worker only skipped creating it. syncOptionalSchedule pauses the schedule of a disabled job, and
 * resumes it once the job is enabled again, unless someone else paused it.
 */
describe('syncOptionalSchedule', () => {
  const DISABLED = { enabled: false, reason: 'AUDIT_ARCHIVE_ENABLED is not true' };

  function client(state: { paused: boolean; note?: string } | 'missing') {
    const handle = {
      describe: jest.fn(async () => {
        if (state === 'missing')
          throw new ScheduleNotFoundError('not found', 'audit-archive-daily');
        return { ...stored, state };
      }),
      pause: jest.fn().mockResolvedValue(undefined),
      update: jest.fn(async (fn: (previous: ScheduleDescription) => unknown) => {
        handle.updated = fn({ ...stored, state } as ScheduleDescription);
      }),
      updated: undefined as unknown,
    };
    const fake = {
      create: jest
        .fn()
        .mockRejectedValue(new ScheduleAlreadyRunning('exists', 'audit-archive-daily')),
      getHandle: jest.fn(() => handle),
    };
    return { handle, fake, schedules: fake as unknown as ScheduleClient };
  }

  it("pauses a disabled job's running schedule, naming the variable", async () => {
    const { handle, schedules } = client({ paused: false });

    expect(await syncOptionalSchedule(schedules, options('0 3 * * *'), DISABLED, logger)).toBe(
      'paused',
    );
    expect(handle.pause).toHaveBeenCalledWith(
      expect.stringContaining('AUDIT_ARCHIVE_ENABLED is not true'),
    );
  });

  it('creates nothing for a disabled job without a schedule', async () => {
    const { fake, handle, schedules } = client('missing');

    expect(await syncOptionalSchedule(schedules, options('0 3 * * *'), DISABLED, logger)).toBe(
      'absent',
    );
    expect(fake.create).not.toHaveBeenCalled();
    expect(handle.pause).not.toHaveBeenCalled();
  });

  it('leaves a schedule that is paused already', async () => {
    const { handle, schedules } = client({ paused: true, note: 'paused for maintenance' });

    expect(await syncOptionalSchedule(schedules, options('0 3 * * *'), DISABLED, logger)).toBe(
      'already-paused',
    );
    expect(handle.pause).not.toHaveBeenCalled();
  });

  it('resumes the schedule the worker paused once the job is enabled again', async () => {
    const { handle, schedules } = client({ paused: false });
    await syncOptionalSchedule(schedules, options('0 3 * * *'), DISABLED, logger);
    const note = handle.pause.mock.calls[0][0] as string;
    const enabled = client({ paused: true, note });

    expect(
      await syncOptionalSchedule(
        enabled.schedules,
        options('0 3 * * *'),
        { enabled: true },
        logger,
      ),
    ).toBe('updated');
    expect(enabled.handle.updated).toMatchObject({ state: { paused: false } });
  });

  it('keeps a schedule paused by someone else paused when the job is enabled', async () => {
    const { handle, schedules } = client({ paused: true, note: 'paused for maintenance' });

    await syncOptionalSchedule(schedules, options('0 3 * * *'), { enabled: true }, logger);

    expect(handle.updated).toMatchObject({
      state: { paused: true, note: 'paused for maintenance' },
    });
  });
});
