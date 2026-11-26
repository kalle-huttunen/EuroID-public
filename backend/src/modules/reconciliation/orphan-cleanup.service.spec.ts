/**
 * OrphanCleanupService with a fake Temporal client. ADOPT or DELETE of an orphan whose cleanup had
 * ended, or never started, answered 500 or "Orphan workflow not yet started": now a fresh cleanup
 * run for the drift starts with the action. A drift closed by hand stops its cleanup.
 * The real workflow behaviour is in test/workflows/reconciliation-orphan-cleanup-start.
 */
import { ConflictException } from '@nestjs/common';
import { WorkflowNotFoundError } from '@temporalio/common';
import type { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { orphanCleanupWorkflow } from '../../workflows/orphan-cleanup.workflow';
import { OrphanCleanupService } from './orphan-cleanup.service';
import type { DriftDocument } from './schemas/drift.schema';

const DRIFT_ID = '6650aaaaaaaaaaaaaaaaaaaa';
const FRESH_ID = `t-tenant-a-orphan-cleanup-${DRIFT_ID}`;

const drift = (fields: Record<string, unknown> = {}) =>
  ({
    _id: DRIFT_ID,
    type: 'ORPHAN_ACCOUNT',
    status: 'quarantined',
    tenantId: 'tenant-a',
    targetSystem: 'entra-id',
    userId: 'ext-1',
    userEmail: 'orphan@corp.example',
    orphanDetails: { targetSystem: 'entra-id', externalId: 'ext-1' },
    ...fields,
  }) as unknown as DriftDocument;

function setup(statuses: Record<string, string>) {
  const signal = jest.fn().mockResolvedValue(undefined);
  const cancel = jest.fn().mockResolvedValue(undefined);
  const describeWorkflow = jest.fn(async (workflowId: string) => {
    const status = statuses[workflowId];
    if (!status) throw new WorkflowNotFoundError('Workflow not found', workflowId, undefined);
    return { status: { name: status } };
  });
  const signalWithStart = jest.fn().mockResolvedValue({});
  const client = {
    workflow: {
      getHandle: (workflowId: string) => ({
        describe: () => describeWorkflow(workflowId),
        signal: (...args: unknown[]) => signal(workflowId, ...args),
        cancel: () => cancel(workflowId),
      }),
      signalWithStart,
    },
  };
  const service = new OrphanCleanupService({
    getClient: () => client,
  } as unknown as TemporalClientProvider);
  return { service, signal, cancel, describeWorkflow, signalWithStart };
}

describe('OrphanCleanupService.signal', () => {
  it('signals the running cleanup of the drift', async () => {
    const { service, signal, signalWithStart } = setup({ 'cleanup-1': 'RUNNING' });

    const id = await service.signal(drift({ workflowId: 'cleanup-1' }), 'ADOPT', 'identity-1');

    expect(id).toBe('cleanup-1');
    expect(signal).toHaveBeenCalledWith('cleanup-1', 'ADOPT_ACCOUNT', 'identity-1');
    expect(signalWithStart).not.toHaveBeenCalled();
  });

  it.each([
    ['has ended', { workflowId: 'cleanup-1' }, { 'cleanup-1': 'COMPLETED' }],
    ['is unknown to Temporal', { workflowId: 'cleanup-1' }, {}],
    ['never started', {}, {}],
  ])(
    'starts a fresh cleanup run with the action when the cleanup %s',
    async (_label, fields, statuses) => {
      const { service, signal, signalWithStart } = setup(statuses);

      const id = await service.signal(drift(fields), 'DELETE');

      expect(id).toBe(FRESH_ID);
      expect(signal).not.toHaveBeenCalled();
      expect(signalWithStart).toHaveBeenCalledWith(orphanCleanupWorkflow, {
        taskQueue: 'provisioning-default',
        workflowId: FRESH_ID,
        args: [
          {
            driftId: DRIFT_ID,
            targetSystem: 'entra-id',
            externalId: 'ext-1',
            accountIdentifier: 'orphan@corp.example',
            tenantId: 'tenant-a',
          },
        ],
        signal: 'DELETE_ACCOUNT',
        signalArgs: [],
        searchAttributes: { TenantId: ['tenant-a'] },
        memo: expect.objectContaining({ triggeredBy: 'OrphanCleanupService' }),
      });
    },
  );

  // The decision's decidedBy: the operator, not 'workflow-signal' (hunt 05 F17)
  it('passes who decided after the action arguments', async () => {
    const { service, signal, signalWithStart } = setup({ 'cleanup-1': 'RUNNING' });

    await service.signal(drift({ workflowId: 'cleanup-1' }), 'ADOPT', 'identity-1', 'ops@x.fi');
    await service.signal(drift(), 'DELETE', undefined, 'ops@x.fi');

    expect(signal).toHaveBeenCalledWith('cleanup-1', 'ADOPT_ACCOUNT', 'identity-1', 'ops@x.fi');
    expect(signalWithStart).toHaveBeenCalledWith(
      orphanCleanupWorkflow,
      expect.objectContaining({ signal: 'DELETE_ACCOUNT', signalArgs: ['ops@x.fi'] }),
    );
  });

  it('passes the identity with ADOPT to a fresh run', async () => {
    const { service, signalWithStart } = setup({});

    await service.signal(drift(), 'ADOPT', 'identity-1');

    expect(signalWithStart).toHaveBeenCalledWith(
      orphanCleanupWorkflow,
      expect.objectContaining({ signal: 'ADOPT_ACCOUNT', signalArgs: ['identity-1'] }),
    );
  });

  it.each(['ignored', 'corrected'])(
    'refuses a %s drift whose cleanup has ended with 409, starting nothing',
    async (status) => {
      const { service, signalWithStart } = setup({ 'cleanup-1': 'COMPLETED' });

      await expect(
        service.signal(drift({ status, workflowId: 'cleanup-1' }), 'DELETE'),
      ).rejects.toThrow(ConflictException);
      expect(signalWithStart).not.toHaveBeenCalled();
    },
  );

  it('fails on a Temporal error other than not found, starting nothing', async () => {
    const { service, describeWorkflow, signalWithStart } = setup({});
    describeWorkflow.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service.signal(drift({ workflowId: 'cleanup-1' }), 'DELETE')).rejects.toThrow(
      'connection refused',
    );
    expect(signalWithStart).not.toHaveBeenCalled();
  });
});

describe('OrphanCleanupService.stop', () => {
  it('cancels a running cleanup', async () => {
    const { service, cancel } = setup({ 'cleanup-1': 'RUNNING' });

    await service.stop('cleanup-1');

    expect(cancel).toHaveBeenCalledWith('cleanup-1');
  });

  it.each([
    ['has ended', { 'cleanup-1': 'COMPLETED' }],
    ['is unknown to Temporal', {}],
  ])('leaves a cleanup that %s as it is', async (_label, statuses) => {
    const { service, cancel } = setup(statuses);

    await expect(service.stop('cleanup-1')).resolves.toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('takes a cleanup that ended between the check and the cancel as stopped', async () => {
    const { service, cancel } = setup({ 'cleanup-1': 'RUNNING' });
    cancel.mockRejectedValueOnce(new WorkflowNotFoundError('done', 'cleanup-1', undefined));

    await expect(service.stop('cleanup-1')).resolves.toBeUndefined();
  });
});
