/**
 * applyMoverAccess: the identity read by id in the activity's tenant, failures classified for
 * Temporal and masked before they reach workflow history, and the activity registered on each
 * mover connector's own queue.
 */
import { HttpStatus } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { QUEUE_NAMES } from '@infrastructure/temporal/task-queue.config';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import type { MoverAccessTask } from '@shared/types/mover';
import type { IdentityService } from '../modules/identity/identity.service';
import type { MoverTargetAccessService } from '../modules/mover/mover-target-access.service';
import { MoverAccessActivities, moverAccessQueueActivities } from './mover-access.activities';
import { DEPROVISION_REJECTED } from './deprovision-failure';

const TENANT = 'tenant-a';
const TASK: MoverAccessTask = {
  identityId: 'id-1',
  connector: 'okta',
  operations: [
    { type: 'group', action: 'remove', targetId: '00g-sales' },
    { type: 'group', action: 'add', targetId: '00g-eng' },
  ],
};

function setup() {
  const tenants: string[] = [];
  const identityDoc = { _id: 'id-1', profile: { email: 'ada@acme.test' } };
  const identityService = {
    findIdentityById: jest.fn(async () => {
      tenants.push(requestContext.getStore()?.tenantId ?? '');
      return identityDoc as unknown;
    }),
  };
  const targets = { apply: jest.fn(async () => ({ changed: 2, unchanged: 0 })) };
  const activities = new MoverAccessActivities(
    identityService as unknown as IdentityService,
    targets as unknown as MoverTargetAccessService,
  );
  return { activities, identityService, targets, tenants, identityDoc };
}

describe('MoverAccessActivities.applyMoverAccess', () => {
  it("reads the identity by id in the task's tenant and applies the operations", async () => {
    const { activities, identityService, targets, tenants, identityDoc } = setup();

    await expect(activities.applyMoverAccess(TASK, TENANT, 'wf-1')).resolves.toEqual({
      changed: 2,
      unchanged: 0,
    });

    expect(identityService.findIdentityById).toHaveBeenCalledWith('id-1');
    expect(tenants).toEqual([TENANT]);
    expect(targets.apply).toHaveBeenCalledWith(
      'okta',
      identityDoc,
      TASK.operations,
      TENANT,
      'wf-1',
    );
  });

  it('fails at once when the identity no longer exists', async () => {
    const { activities, identityService, targets } = setup();
    identityService.findIdentityById.mockResolvedValue(null);

    const error = await activities.applyMoverAccess(TASK, TENANT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect(targets.apply).not.toHaveBeenCalled();
  });

  it('fails a client error at once with the email masked', async () => {
    const { activities, targets } = setup();
    targets.apply.mockRejectedValue(
      new ConnectorException('No Okta user ada@acme.test', HttpStatus.UNPROCESSABLE_ENTITY),
    );

    const error = (await activities
      .applyMoverAccess(TASK, TENANT)
      .catch((e: unknown) => e)) as ApplicationFailure;

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error.nonRetryable).toBe(true);
    expect(error.type).toBe(DEPROVISION_REJECTED);
    expect(error.message).toBe('okta: No Okta user a•••@acme.test (HTTP 422)');
  });

  it('lets a server or network error be retried, masked in message and stack', async () => {
    const { activities, targets } = setup();
    targets.apply.mockRejectedValue(new Error('socket hang up talking about ada@acme.test'));

    const error = (await activities
      .applyMoverAccess(TASK, TENANT)
      .catch((e: unknown) => e)) as Error;

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect(error.message).toBe('okta: socket hang up talking about a•••@acme.test');
    expect(error.stack).not.toContain('ada@acme.test');
  });

  it('refuses to run without a tenant', async () => {
    const { activities, identityService } = setup();
    await expect(activities.applyMoverAccess(TASK, '')).rejects.toThrow('tenantId is required');
    expect(identityService.findIdentityById).not.toHaveBeenCalled();
  });
});

describe('moverAccessQueueActivities', () => {
  it('registers applyMoverAccess on the Entra ID, AD, Okta and SCIM queues only', () => {
    const { activities } = setup();
    const byQueue = moverAccessQueueActivities(activities);

    expect(Object.keys(byQueue).sort()).toEqual(
      [QUEUE_NAMES['entra'], QUEUE_NAMES['ad'], QUEUE_NAMES['okta'], QUEUE_NAMES['scim']].sort(),
    );
    for (const onQueue of Object.values(byQueue)) {
      expect(Object.keys(onQueue)).toEqual(['applyMoverAccess']);
    }
  });
});
