/**
 * The actor of a distributed transaction (workflow memo `triggeredBy`, transaction log
 * `initiatedBy`) is the authenticated caller. A body `initiatedBy` is dropped, so the recorded
 * actor cannot be spoofed. The tenant is the request's: a body `tenantId` (top level or on the
 * user) never moves the transaction, its activities or its log into another tenant.
 */

import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import type { AuthUser } from '@infrastructure/auth/auth-user.decorator';

function setup(rules: Array<Record<string, unknown>> = []) {
  const start = jest.fn().mockResolvedValue(undefined);
  const provider = {
    getClient: () => ({ workflow: { start } }),
  } as unknown as TemporalClientProvider;
  const devTools = { recordTransaction: jest.fn().mockResolvedValue({}) };
  const correlationConfig = { getCorrelationConfig: jest.fn().mockResolvedValue({ rules }) };
  const correlationHash = { hash: jest.fn((value: string) => `hash-of-${value.length}`) };
  const service = new ReconciliationService(
    devTools as never,
    { logFireAndForget: jest.fn() } as never,
    provider,
    correlationConfig as never,
    correlationHash as never,
  );
  return {
    controller: new ReconciliationController(service, {} as never, {} as never, {} as never),
    start,
    devTools,
    correlationConfig,
  };
}

const body = {
  transactionId: 'tx-1',
  user: {
    sourceSystem: 'csv-hr',
    sourceUserId: 'e-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    status: 'ACTIVE',
  },
  targetSystems: ['entra-id'],
  operation: 'CREATE',
  initiatedBy: 'someone-else@example.com',
};

const caller = {
  sub: 'admin-1',
  email: 'operator@tenant-a.example',
  name: 'Operator',
  roles: ['operator'],
  tenantId: 'tenant-a',
} as AuthUser;

describe('POST /reconciliation/distributed-transaction actor', () => {
  it('records the authenticated caller and ignores initiatedBy in the body', async () => {
    const { controller, start, devTools } = setup();

    await withTenantContext('tenant-a', () => controller.startDistributedTransaction(body, caller));

    const [, options] = start.mock.calls[0];
    expect(options.memo.triggeredBy).toBe('operator@tenant-a.example');
    expect(options.args[0].initiatedBy).toBe('operator@tenant-a.example');
    expect(devTools.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ initiatedBy: 'operator@tenant-a.example', tenantId: 'tenant-a' }),
    );
    expect(JSON.stringify(start.mock.calls)).not.toContain('someone-else@example.com');
  });

  it('works without initiatedBy in the body', async () => {
    const { controller, start } = setup();
    const { initiatedBy: _dropped, ...withoutActor } = body;

    const res = await withTenantContext('tenant-a', () =>
      controller.startDistributedTransaction(withoutActor, caller),
    );

    expect(res.success).toBe(true);
    expect(start.mock.calls[0][1].memo.triggeredBy).toBe('operator@tenant-a.example');
  });
});

describe('POST /reconciliation/distributed-transaction tenant', () => {
  it('runs in the caller tenant when the body names another tenant', async () => {
    const { controller, start, devTools } = setup();
    const crossTenant = {
      ...body,
      tenantId: 'tenant-b',
      user: { ...body.user, tenantId: 'tenant-b' },
    };

    const res = await withTenantContext('tenant-a', () =>
      controller.startDistributedTransaction(crossTenant, caller),
    );

    expect(res.workflowId).toBe('t-tenant-a-dist-tx-tx-1');
    const [, options] = start.mock.calls[0];
    expect(options.workflowId).toBe('t-tenant-a-dist-tx-tx-1');
    expect(options.args[0].tenantId).toBe('tenant-a');
    expect(options.args[0].user.tenantId).toBe('tenant-a');
    expect(options.searchAttributes).toEqual({ TenantId: ['tenant-a'] });
    expect(devTools.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
    expect(JSON.stringify(start.mock.calls)).not.toContain('tenant-b');
    expect(JSON.stringify(devTools.recordTransaction.mock.calls)).not.toContain('tenant-b');
  });
});

/**
 * The user schema is a passthrough, so a national ID sent as `hetu`, under the tenant's Hashed
 * National ID field or in customAttributes went into the workflow input and its Temporal history;
 * only the Hub write stripped it (package F report). It is taken out before the start, as bulk
 * provisioning does, and with the tenant's rule its hash goes in as the user's correlationId,
 * which the Hub save matches on.
 */
describe('POST /reconciliation/distributed-transaction national ID', () => {
  const withNationalId = {
    ...body,
    user: {
      ...body.user,
      hetu: '010190-123A',
      customAttributes: { hetu: '010190-123A', badge: 'B-7' },
    },
  };

  it('starts the workflow with no national ID in its input', async () => {
    const { controller, start } = setup();

    await withTenantContext('tenant-a', () =>
      controller.startDistributedTransaction(withNationalId, caller),
    );

    const input = start.mock.calls[0][1].args[0];
    expect(JSON.stringify(input)).not.toContain('010190');
    expect(input.user.customAttributes).toEqual({ badge: 'B-7' });
    expect(input.user).not.toHaveProperty('correlationId');
  });

  it("puts the hash in as correlationId under the tenant's rule, dropping the body's", async () => {
    const rule = { strategy: 'hashedNationalId', nationalIdSourceField: 'personnelCode' };
    const { controller, start, correlationConfig } = setup([rule]);

    await withTenantContext('tenant-a', () =>
      controller.startDistributedTransaction(
        {
          ...withNationalId,
          user: { ...withNationalId.user, personnelCode: '010190-123A', correlationId: 'forged' },
        },
        caller,
      ),
    );

    expect(correlationConfig.getCorrelationConfig).toHaveBeenCalledWith('tenant-a', {
      strict: true,
    });
    const input = start.mock.calls[0][1].args[0];
    expect(input.user.correlationId).toBe('hash-of-11');
    expect(JSON.stringify(input)).not.toContain('010190');
  });
});
