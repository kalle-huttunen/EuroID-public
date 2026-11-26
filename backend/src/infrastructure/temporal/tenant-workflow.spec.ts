/**
 * Workflow ids are guessable, so every route that reads or controls a Temporal workflow by an id
 * from the request answers 404 for another tenant's workflow and never touches it (no query,
 * result, history, signal or terminate). Runs the real controllers and services over a fake
 * Temporal client holding one workflow per tenant.
 */

import { NotFoundException } from '@nestjs/common';
import {
  defineSearchAttributeKey,
  SearchAttributeType,
  TypedSearchAttributes,
  WorkflowNotFoundError,
} from '@temporalio/common';
import type { Client, WorkflowExecutionDescription } from '@temporalio/client';
import { withTenantContext } from '../multi-tenancy/tenant-context.helper';
import { getTenantWorkflow, workflowTenantId } from './tenant-workflow';
import type { TemporalClientProvider } from './temporal-client.provider';
import { DevToolsController } from '../../modules/dev-tools/dev-tools.controller';
import { DevToolsService } from '../../modules/dev-tools/dev-tools.service';
import { BulkProvisioningController } from '../../modules/bulk-provisioning/bulk-provisioning.controller';
import { BulkProvisioningService } from '../../modules/bulk-provisioning/bulk-provisioning.service';
import { OnboardingController } from '../../modules/onboarding/onboarding.controller';
import { OnboardingService } from '../../modules/onboarding/onboarding.service';
import { BatchProvisionService } from '../../modules/onboarding/batch-provision.service';
import { ReconciliationController } from '../../modules/reconciliation/reconciliation.controller';
import { ReconciliationService } from '../../modules/reconciliation/reconciliation.service';
import type { AuthUser } from '../auth/auth-user.decorator';

const TENANT_KEY = defineSearchAttributeKey('TenantId', SearchAttributeType.KEYWORD);

/** Ids of the two workflows the fake Temporal holds; tenant-a only reads OWN. */
const OWN = 't-tenant-a-bulk-batch-1-1';
const FOREIGN = 't-tenant-b-bulk-batch-1-1';

function description(workflowId: string, tenantId: string): WorkflowExecutionDescription {
  return {
    workflowId,
    runId: 'run-1',
    type: 'bulkProvisioningWorkflow',
    taskQueue: 'provisioning-default',
    status: { code: 2, name: 'COMPLETED' },
    historyLength: 10,
    startTime: new Date('2026-11-22T10:00:00Z'),
    closeTime: new Date('2026-11-22T10:01:00Z'),
    executionTime: undefined,
    memo: { triggeredBy: 'someone@tenant.example' },
    searchAttributes: { TenantId: [tenantId] },
    typedSearchAttributes: new TypedSearchAttributes([{ key: TENANT_KEY, value: tenantId }]),
    raw: {},
  } as unknown as WorkflowExecutionDescription;
}

function fakeTemporal() {
  const touched: string[] = [];
  const handles = new Map<string, Record<string, jest.Mock>>();
  for (const [id, tenant] of [
    [OWN, 'tenant-a'],
    [FOREIGN, 'tenant-b'],
  ] as const) {
    const touch = (what: string, value: unknown) =>
      jest.fn(async () => {
        touched.push(`${what}:${id}`);
        return value;
      });
    handles.set(id, {
      describe: jest.fn(async () => description(id, tenant)),
      query: touch('query', 'COMPLETED'),
      result: touch('result', { batchId: 'batch-1', results: [] }),
      fetchHistory: touch('history', { events: [] }),
      signal: touch('signal', undefined),
      terminate: touch('terminate', undefined),
    });
  }
  const missing = {
    describe: jest.fn(async () => {
      throw new WorkflowNotFoundError('not found', 'nope', undefined);
    }),
  };
  const client = {
    workflow: { getHandle: (id: string) => handles.get(id) ?? missing },
  } as unknown as Client;
  const provider = {
    getClient: () => client,
    isConnected: () => true,
  } as unknown as TemporalClientProvider;
  /** What the routes did to the other tenant's workflow, beyond describing it. */
  const foreignTouches = () => touched.filter((t) => t.endsWith(`:${FOREIGN}`));
  return { client, provider, foreignTouches, touched };
}

const asTenantA = <T>(fn: () => Promise<T>) => withTenantContext('tenant-a', fn) as Promise<T>;
const user = { sub: 'u1', email: 'op@tenant-a.example', roles: ['operator'], tenantId: 'tenant-a' };
const audit = { logFireAndForget: jest.fn(), log: jest.fn() };

describe('getTenantWorkflow', () => {
  it('reads the tenant from the typed or the untyped search attribute', () => {
    const typed = description(OWN, 'tenant-a');
    const untypedOnly = {
      ...typed,
      typedSearchAttributes: new TypedSearchAttributes(),
    } as WorkflowExecutionDescription;

    expect(workflowTenantId(typed)).toBe('tenant-a');
    expect(workflowTenantId(untypedOnly)).toBe('tenant-a');
  });

  it("returns the caller's own workflow", async () => {
    const { client } = fakeTemporal();

    const { description: d } = await asTenantA(() => getTenantWorkflow(client, OWN));

    expect(d.workflowId).toBe(OWN);
  });

  it('answers 404 for another tenant, for a workflow without TenantId and for a missing one', async () => {
    const { client } = fakeTemporal();
    const untagged = {
      workflow: {
        getHandle: () => ({
          describe: async () => ({
            ...description(OWN, 'x'),
            searchAttributes: {},
            typedSearchAttributes: new TypedSearchAttributes(),
          }),
        }),
      },
    } as unknown as Client;

    await expect(asTenantA(() => getTenantWorkflow(client, FOREIGN))).rejects.toThrow(
      NotFoundException,
    );
    await expect(asTenantA(() => getTenantWorkflow(untagged, OWN))).rejects.toThrow(
      NotFoundException,
    );
    await expect(asTenantA(() => getTenantWorkflow(client, 'nope'))).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('Workflow routes refuse another tenant’s workflow id', () => {
  it('GET /dev/workflows/:workflowId', async () => {
    const { provider, foreignTouches } = fakeTemporal();
    const controller = new DevToolsController(new DevToolsService({} as never, provider));

    const own = await asTenantA(() => controller.getWorkflowDetail(OWN));
    expect(own.workflow?.workflowId).toBe(OWN);
    await expect(asTenantA(() => controller.getWorkflowDetail(FOREIGN))).rejects.toThrow(
      NotFoundException,
    );
    expect(foreignTouches()).toEqual([]);
  });

  describe('bulk provisioning', () => {
    const setup = () => {
      const temporal = fakeTemporal();
      // No correlation settings or hash service: these reads start no workflow
      const service = new BulkProvisioningService(
        audit as never,
        temporal.provider,
        {} as never,
        {} as never,
      );
      return { ...temporal, controller: new BulkProvisioningController(service, audit as never) };
    };

    it('GET status, results and partial-results/:workflowId', async () => {
      const { controller, foreignTouches } = setup();

      await expect(asTenantA(() => controller.getStatus(OWN))).resolves.toMatchObject({
        success: true,
      });
      await expect(
        asTenantA(() => controller.getResults(OWN, user as AuthUser)),
      ).resolves.toMatchObject({ success: true });
      await expect(asTenantA(() => controller.getStatus(FOREIGN))).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        asTenantA(() => controller.getResults(FOREIGN, user as AuthUser)),
      ).rejects.toMatchObject({ status: 404 });
      await expect(asTenantA(() => controller.getPartialResults(FOREIGN))).rejects.toMatchObject({
        status: 404,
      });
      expect(foreignTouches()).toEqual([]);
    });

    it('POST approve-deletes and cancel/:workflowId neither signal nor terminate it', async () => {
      const { controller, foreignTouches } = setup();

      await expect(
        asTenantA(() => controller.approveDeletes(FOREIGN, user as AuthUser)),
      ).rejects.toThrow(NotFoundException);
      await expect(
        asTenantA(() => controller.cancelWorkflow(FOREIGN, user as AuthUser)),
      ).rejects.toThrow(NotFoundException);
      expect(foreignTouches()).toEqual([]);
    });
  });

  it('GET /onboarding/status/:workflowId', async () => {
    const { provider, foreignTouches } = fakeTemporal();
    const controller = new OnboardingController(
      new OnboardingService(audit as never, { create: () => ({}) } as never, provider),
      {} as never,
    );

    await expect(asTenantA(() => controller.getStatus(OWN))).resolves.toMatchObject({
      workflowId: OWN,
    });
    await expect(asTenantA(() => controller.getStatus(FOREIGN))).rejects.toThrow(NotFoundException);
    expect(foreignTouches()).toEqual([]);
  });

  it('GET /batch-provision/status/:workflowId', async () => {
    const { provider, foreignTouches } = fakeTemporal();
    const service = new BatchProvisionService({} as never, {} as never, provider);

    await expect(asTenantA(() => service.getProvisioningStatus(OWN))).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    await expect(asTenantA(() => service.getProvisioningStatus(FOREIGN))).rejects.toThrow(
      NotFoundException,
    );
    expect(foreignTouches()).toEqual([]);
  });

  it('GET /reconciliation/status and result/:workflowId', async () => {
    const { provider, foreignTouches } = fakeTemporal();
    const service = new ReconciliationService(
      {} as never,
      audit as never,
      provider,
      {} as never,
      {} as never,
    );
    const controller = new ReconciliationController(service, {} as never, {} as never, {} as never);

    await expect(asTenantA(() => controller.getStatus(OWN))).resolves.toMatchObject({
      workflowId: OWN,
    });
    await expect(asTenantA(() => controller.getStatus(FOREIGN))).rejects.toMatchObject({
      status: 404,
    });
    await expect(asTenantA(() => controller.getResult(FOREIGN))).rejects.toMatchObject({
      status: 404,
    });
    expect(foreignTouches()).toEqual([]);
  });
});
