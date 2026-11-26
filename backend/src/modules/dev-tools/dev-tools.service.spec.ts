import { randomBytes } from 'crypto';
import { defaultPayloadConverter } from '@temporalio/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TemporalPayloadCodec } from '@infrastructure/temporal/temporal-payload-codec';
import { DevToolsService } from './dev-tools.service';

type Deps = ConstructorParameters<typeof DevToolsService>;

describe('DevToolsService.updateTransactionPhase', () => {
  const findOneAndUpdate = jest.fn();
  const service = new DevToolsService({ findOneAndUpdate } as unknown as Deps[0], {} as Deps[1]);

  beforeEach(() => {
    findOneAndUpdate.mockReset().mockResolvedValue(null);
  });

  it.each(['COMMITTED', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'FAILED'] as const)(
    'sets completedAt when the transaction ends %s',
    async (phase) => {
      await service.updateTransactionPhase('tx-1', phase);

      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { transactionId: 'tx-1' },
        { $set: { phase, completedAt: expect.any(Date) } },
      );
    },
  );

  it('clears completedAt when a rollback follows a failed commit', async () => {
    const participants = [{ systemName: 'entra-id', status: 'COMMITTED' as const }];

    await service.updateTransactionPhase('tx-1', 'ROLLING_BACK', participants);

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { transactionId: 'tx-1' },
      { $set: { phase: 'ROLLING_BACK', participants }, $unset: { completedAt: 1 } },
    );
  });
});

describe('DevToolsService.getWorkflowDetail', () => {
  const codec = new TemporalPayloadCodec(() => ({
    currentKeyId: 'key-1',
    keys: new Map([['key-1', randomBytes(32)]]),
  }));
  const WORKFLOW_ID = 't-tenant-a-onboard-identity-1';

  /** A client whose history holds one completed activity, its result encrypted as stored. */
  const clientWithHistory = async (resultValue: unknown) => {
    const [result] = await codec.encode([defaultPayloadConverter.toPayload(resultValue)]);
    const handle = {
      describe: async () => ({
        workflowId: WORKFLOW_ID,
        status: { name: 'COMPLETED' },
        searchAttributes: { TenantId: ['tenant-a'] },
      }),
      fetchHistory: async () => ({
        events: [
          {
            eventId: 5,
            activityTaskScheduledEventAttributes: { activityType: { name: 'provisionEntra' } },
          },
          { eventId: 6, activityTaskStartedEventAttributes: { scheduledEventId: 5 } },
          {
            eventId: 7,
            activityTaskCompletedEventAttributes: {
              scheduledEventId: 5,
              result: { payloads: [result] },
            },
          },
        ],
      }),
    };
    return {
      options: { loadedDataConverter: { payloadCodecs: [codec] } },
      workflow: { getHandle: () => handle },
    };
  };

  it("shows an activity's output, which the payload codec stores encrypted", async () => {
    const client = await clientWithHistory({ success: true, objectId: 'entra-obj-1' });
    const provider = { isConnected: () => true, getClient: () => client };
    const service = new DevToolsService({} as Deps[0], provider as unknown as Deps[1]);

    const detail = await withTenantContext('tenant-a', () =>
      service.getWorkflowDetail(WORKFLOW_ID),
    );

    expect(detail?.steps).toEqual([
      expect.objectContaining({
        name: 'provisionEntra',
        status: 'completed',
        output: { success: true, objectId: 'entra-obj-1' },
      }),
    ]);
  });
});

describe('DevToolsService.listWorkflows', () => {
  it("lists the caller tenant's workflows with the tenant id escaped in the query", async () => {
    const list = jest.fn(() => (async function* () {})());
    const provider = { isConnected: () => true, getClient: () => ({ workflow: { list } }) };
    const service = new DevToolsService({} as Deps[0], provider as unknown as Deps[1]);

    await service.listWorkflows({ tenantId: 'x" OR TenantId != "' });

    expect(list).toHaveBeenCalledWith({
      query: 'TenantId = "x\\" OR TenantId != \\""',
      pageSize: 50,
    });
  });
});
