/**
 * How provisionUserToEntra, disableEntraUser and enableEntraUser fail, so that Temporal retries
 * only what a retry can fix: a Graph 4xx (other than 408/409/429), refused credentials and an
 * incomplete or missing Entra ID config fail at once; a 429 waits; a 5xx or no answer is retried.
 * And provisionUserToEntra fails when Entra ID did not make one of the intent's changes, after
 * the others were made, never reporting success for it. The Entra service is mocked with the
 * exceptions EntraClient makes of Graph's answers. Not run against a live tenant.
 */
import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { EntraActivities } from './entra.activities';
import type { EntraService } from '../modules/connectors/entra-connector/entra.service';
import type { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import type { ProvisioningOperationResult } from '@shared/dtos/provisioning-result.dto';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { DomainEventType } from '@infrastructure/events/event-types';
import { createMockUser } from '@testing/mock-factories';
import { createMockEventEmitter, TEST_TENANT_ID } from '@testing/test-helpers';
import type { IdentityService } from '../modules/identity/identity.service';

const GRAPH_403 = new ConnectorException(
  'Entra API Error (HTTP 403): {"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}',
);
/** A new one each time: asDeprovisionFailure rewrites a retryable error's message in place. */
const graph503 = () =>
  new ConnectorException(
    'Entra API Error (HTTP 503): {"code":"serviceNotAvailable"}',
    HttpStatus.BAD_GATEWAY,
  );

function setup() {
  const entraService = {
    provision: jest.fn(),
    checkUserExists: jest.fn().mockResolvedValue('obj-1'),
    disableUser: jest.fn().mockResolvedValue(true),
    enableUser: jest.fn().mockResolvedValue(true),
  };
  const eventEmitter = createMockEventEmitter();
  const activities = new EntraActivities(
    entraService as unknown as EntraService,
    eventEmitter as never,
    {} as EntitlementCatalogService,
    { findIdentityById: jest.fn().mockResolvedValue(null) } as unknown as IdentityService,
  );
  const provision = () =>
    activities.provisionUserToEntra(
      createMockUser({ email: 'ada@corp.test' }),
      { operations: [{ type: 'group', action: 'remove', targetId: 'Sales' }] },
      undefined,
      TEST_TENANT_ID,
    );
  const emitted = (type: DomainEventType) =>
    eventEmitter.emit.mock.calls.filter(([t]: unknown[]) => t === type).map((call) => call[2]);
  return { activities, entraService, provision, emitted };
}

const op = (
  action: 'add' | 'remove',
  targetId: string,
  outcome: ProvisioningOperationResult['outcome'],
  failure?: { reason: string; status?: number },
): ProvisioningOperationResult => ({ type: 'group', action, targetId, outcome, ...failure });

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

const nonRetryable = (e: Error) => e instanceof ApplicationFailure && e.nonRetryable;

describe('provisionUserToEntra: a call that fails', () => {
  it.each([
    ['a Graph 4xx', GRAPH_403],
    ['refused credentials', new UnauthorizedException('Could not authenticate with Entra ID')],
    [
      'an incomplete Entra ID config',
      new ConnectorException('Entra ID config is incomplete (empty: clientSecret)'),
    ],
    ['no Entra ID config', new ConnectorException('Missing Entra Config: install the connector')],
  ])('fails at once on %s, and says so in provisioning.failed', async (_case, error) => {
    const { entraService, provision, emitted } = setup();
    entraService.provision.mockRejectedValue(error);

    const failure = await failureOf(provision());

    expect(nonRetryable(failure)).toBe(true);
    expect(failure.message).toContain(error.message);
    expect(emitted(DomainEventType.PROVISIONING_FAILED)).toEqual([
      expect.objectContaining({ connector: 'entra-id', retryable: false }),
    ]);
  });

  it('keeps a 5xx retryable, and passes a 429 to the rate-limit wait', async () => {
    const { entraService, provision } = setup();
    entraService.provision.mockRejectedValueOnce(graph503());
    const failure = await failureOf(provision());
    expect(failure).toBeInstanceOf(ConnectorException);
    expect(nonRetryable(failure)).toBe(false);

    const throttled = new RateLimitedException(5000, 'entra-id');
    entraService.provision.mockRejectedValueOnce(throttled);
    await expect(provision()).rejects.toBe(throttled);
  });
});

describe('provisionUserToEntra: changes Entra ID did not make', () => {
  it('fails the call with each failed change and its reason, never reporting success', async () => {
    const { entraService, provision, emitted } = setup();
    entraService.provision.mockResolvedValue({
      targetUserId: 'obj-1',
      operations: [
        op('remove', 'Sales', 'failed', { reason: GRAPH_403.message, status: 400 }),
        op('add', 'Engineering', 'applied'),
        op('add', 'All staff', 'unchanged'),
      ],
    });

    const failure = await failureOf(provision());

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).type).toBe('EntraChangesFailed');
    expect(nonRetryable(failure)).toBe(true);
    expect(failure.message).toBe(
      `entra-id: 1 of 3 changes failed (remove group Sales: ${GRAPH_403.message}). ` +
        'The other changes were made or were already as requested.',
    );
    expect(emitted(DomainEventType.PROVISIONING_COMPLETED)).toEqual([]);
    expect(emitted(DomainEventType.PROVISIONING_FAILED)).toEqual([
      expect.objectContaining({ retryable: false, partialFailure: true, error: failure.message }),
    ]);
  });

  it('fails a group name no group has at once', async () => {
    const { entraService, provision } = setup();
    entraService.provision.mockResolvedValue({
      targetUserId: 'obj-1',
      operations: [
        op('add', 'Finance Team', 'failed', {
          reason: 'No Entra ID group has the id or display name "Finance Team"',
          status: 422,
        }),
      ],
    });

    const failure = await failureOf(provision());

    expect(nonRetryable(failure)).toBe(true);
    expect(failure.message).toContain('add group Finance Team: No Entra ID group has');
  });

  it('retries when every failed change can be fixed by a retry (5xx), waits on a 429', async () => {
    const { entraService, provision } = setup();
    entraService.provision.mockResolvedValueOnce({
      targetUserId: 'obj-1',
      operations: [op('remove', 'Sales', 'failed', { reason: graph503().message, status: 502 })],
    });
    const failure = await failureOf(provision());
    expect(failure).toBeInstanceOf(ConnectorException);
    expect(nonRetryable(failure)).toBe(false);

    entraService.provision.mockResolvedValueOnce({
      targetUserId: 'obj-1',
      operations: [op('remove', 'Sales', 'failed', { reason: 'Rate limited', status: 429 })],
    });
    await expect(provision()).rejects.toBeInstanceOf(RateLimitedException);
  });

  it('does not retry a mix: a change a retry cannot fix fails the run anyway', async () => {
    const { entraService, provision } = setup();
    entraService.provision.mockResolvedValue({
      targetUserId: 'obj-1',
      operations: [
        op('remove', 'Sales', 'failed', { reason: graph503().message, status: 502 }),
        op('add', 'Finance', 'failed', { reason: GRAPH_403.message, status: 400 }),
      ],
    });

    expect(nonRetryable(await failureOf(provision()))).toBe(true);
  });

  it('never retries after creating the account, and hands the account over in the details', async () => {
    const { entraService, provision } = setup();
    const generatedAttributes = { mail: 'ada@corp.test', userPrincipalName: 'ada@corp.test' };
    entraService.provision.mockResolvedValue({
      targetUserId: 'obj-new',
      generatedAttributes,
      upnResolution: { chosenUpn: 'ada@corp.test', candidatesChecked: ['ada@corp.test'] },
      // Retryable on its own: a retry would create a second account
      operations: [op('add', 'Finance', 'failed', { reason: graph503().message, status: 502 })],
    });

    const failure = await failureOf(provision());

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(nonRetryable(failure)).toBe(true);
    expect((failure as ApplicationFailure).type).toBe('EntraChangesFailed');
    expect((failure as ApplicationFailure).details).toEqual([
      { objectId: 'obj-new', generatedAttributes },
    ]);
    expect(failure.message).toContain('The account was created');
  });

  it('masks email addresses in the failure message', async () => {
    const { entraService, provision } = setup();
    entraService.provision.mockResolvedValue({
      targetUserId: 'obj-1',
      operations: [
        op('remove', 'Sales', 'failed', {
          reason: "Invalid object identifier 'ada@corp.test'",
          status: 400,
        }),
      ],
    });

    const failure = await failureOf(provision());

    expect(failure.message).toContain("'a•••@corp.test'");
    expect(failure.message).not.toContain('ada@corp.test');
  });

  it('returns each change result when every change was made or already as requested', async () => {
    const { entraService, provision, emitted } = setup();
    const operations = [op('remove', 'Sales', 'applied'), op('add', 'Eng', 'unchanged')];
    entraService.provision.mockResolvedValue({ targetUserId: 'obj-1', operations });

    await expect(provision()).resolves.toMatchObject({
      success: true,
      objectId: 'obj-1',
      operations,
    });
    expect(emitted(DomainEventType.PROVISIONING_COMPLETED)).toEqual([
      expect.objectContaining({
        operations: [
          { action: 'remove', type: 'group', targetId: 'Sales', success: true },
          { action: 'add', type: 'group', targetId: 'Eng', success: true },
        ],
      }),
    ]);
  });
});

describe.each([
  ['disableEntraUser', 'disableUser'],
  ['enableEntraUser', 'enableUser'],
] as const)('%s', (activity, serviceCall) => {
  it('fails at once on a Graph 4xx or refused credentials', async () => {
    const { activities, entraService } = setup();
    entraService[serviceCall].mockRejectedValueOnce(GRAPH_403);
    expect(
      nonRetryable(await failureOf(activities[activity]('ada@corp.test', TEST_TENANT_ID))),
    ).toBe(true);

    entraService.checkUserExists.mockRejectedValueOnce(
      new UnauthorizedException('Could not authenticate with Entra ID'),
    );
    expect(
      nonRetryable(await failureOf(activities[activity]('ada@corp.test', TEST_TENANT_ID))),
    ).toBe(true);
  });

  it('keeps a 5xx retryable', async () => {
    const { activities, entraService } = setup();
    entraService[serviceCall].mockRejectedValueOnce(graph503());

    const failure = await failureOf(activities[activity]('ada@corp.test', TEST_TENANT_ID));

    expect(failure).toBeInstanceOf(ConnectorException);
    expect(nonRetryable(failure)).toBe(false);
  });
});
