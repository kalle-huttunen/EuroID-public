/**
 * What a dead-letter retry or replay re-runs (2.0cu): before, an entry without a domain event was
 * marked replayed although nothing ran, and a re-emit counted as a success whatever its handlers
 * did. Now such entries are refused, a per-handler entry runs only its handler, and a re-emit
 * succeeds only when every handler that ran for it succeeded.
 */
import { ConflictException } from '@nestjs/common';
import { rerunOf } from '@infrastructure/events/handler-dispatch';
import { DeadLetterHandlerRegistry } from './dead-letter-handler.registry';
import { planRerun, rerunnableFilter, type RerunnableEntry } from './dead-letter-rerun';

const EVENT = {
  eventId: 'e-1',
  type: 'identity.created',
  aggregateId: 'id-1',
  payload: { identityId: 'id-1' },
  metadata: { tenantId: 'tenant-a', depth: 0 },
};

const handlerEntry = (handler?: string): RerunnableEntry => ({
  type: 'event_handler_failure',
  originalPayload: EVENT,
  ...(handler ? { handler } : {}),
});

describe('planRerun', () => {
  let emitter: { emitAsync: jest.Mock };
  let registry: DeadLetterHandlerRegistry;

  beforeEach(() => {
    emitter = { emitAsync: jest.fn().mockResolvedValue([]) };
    registry = new DeadLetterHandlerRegistry();
  });

  it.each<[string, RerunnableEntry]>([
    ['a workflow step', { type: 'workflow_terminal', originalPayload: { workflowId: 'wf-1' } }],
    ['a connector error', { type: 'connector_non_retryable', originalPayload: { system: 'scim' } }],
    ['an invalid event', { type: 'event_validation_failure', originalPayload: EVENT }],
    ['a stopped event loop', { type: 'event_chain_depth_exceeded', originalPayload: EVENT }],
    [
      'a webhook delivery captured before 2.0cu (no event)',
      {
        type: 'event_handler_failure',
        originalPayload: { subscriptionId: 's-1', eventType: 'identity.created', eventId: 'e-1' },
      },
    ],
  ])('refuses %s with 409: there is nothing to re-run', (_label, entry) => {
    expect(() => planRerun('dlq-1', entry, emitter, registry)).toThrow(ConflictException);
    expect(() => planRerun('dlq-1', entry, emitter, registry)).toThrow(/dismiss/i);
    expect(emitter.emitAsync).not.toHaveBeenCalled();
  });

  it('refuses an entry whose handler is no longer registered', () => {
    expect(() => planRerun('dlq-1', handlerEntry('GoneHandler.handle'), emitter, registry)).toThrow(
      /GoneHandler\.handle.*not registered/,
    );
    expect(() =>
      planRerun('dlq-1', handlerEntry('GoneHandler.handle'), emitter, undefined),
    ).toThrow(ConflictException);
  });

  it('runs only the named handler with the stored event, not the whole event', async () => {
    const run = jest.fn().mockResolvedValue('done');
    registry.register('AuditEventHandler.handleAll', run);

    await planRerun('dlq-1', handlerEntry('AuditEventHandler.handleAll'), emitter, registry)();

    expect(run).toHaveBeenCalledWith(EVENT);
    expect(emitter.emitAsync).not.toHaveBeenCalled();
  });

  it("fails when the named handler fails again, with the handler's error", async () => {
    registry.register('UserTimelineHandler.handleIdentityCreated', async () => {
      throw new Error('timeline write failed');
    });

    await expect(
      planRerun(
        'dlq-1',
        handlerEntry('UserTimelineHandler.handleIdentityCreated'),
        emitter,
        registry,
      )(),
    ).rejects.toThrow('timeline write failed');
  });

  it('re-emits an event without a handler and succeeds when no handler failed', async () => {
    await expect(planRerun('dlq-1', handlerEntry(), emitter, registry)()).resolves.toBeUndefined();
    expect(emitter.emitAsync).toHaveBeenCalledWith('identity.created', EVENT);
  });

  it('fails a re-emit when a suppressErrors: false listener rejects it', async () => {
    emitter.emitAsync.mockRejectedValue(new Error('mail not sent: 421'));

    await expect(planRerun('dlq-1', handlerEntry(), emitter, registry)()).rejects.toThrow(
      'mail not sent: 421',
    );
  });

  it('fails a re-emit when a wrapped handler failed, even one that started after the emit', async () => {
    // Stands in for HandlerFailureCaptureService's wrapper: an `async: true` listener starts on
    // setImmediate, after emitAsync has resolved, and reports to the re-run's collector.
    emitter.emitAsync.mockImplementation(async (_type: string, event: object) => {
      setImmediate(() => {
        rerunOf(event)?.push(
          Promise.resolve({
            handler: 'GraphSyncService.onIdentityCreated',
            error: new Error('neo4j down'),
          }),
        );
      });
      return [];
    });

    await expect(planRerun('dlq-1', handlerEntry(), emitter, registry)()).rejects.toThrow(
      'GraphSyncService.onIdentityCreated: neo4j down',
    );
  });
});

describe('rerunnableFilter', () => {
  it('selects handler failures with their event, whose handler (if any) is known here', () => {
    expect(rerunnableFilter(['A.b'])).toEqual({
      type: 'event_handler_failure',
      'originalPayload.type': { $exists: true },
      'originalPayload.metadata': { $exists: true },
      $or: [{ handler: null }, { handler: { $in: ['A.b'] } }],
    });
  });
});
