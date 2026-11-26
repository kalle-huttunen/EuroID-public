/**
 * SCIM offboarding and account id write-back through the real activity, service and client
 * against a mocked SCIM 2.0 server (axios mocked): stored id, lookup fallback for accounts
 * provisioned before the write-back (by the identity's UPN and email, matching resources only),
 * already gone, a lookup miss an admin must check, auth failure, rate limit.
 */
import axios from 'axios';
import { ApplicationFailure } from '@temporalio/common';
import { ScimActivities } from './scim.activities';
import { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import { SCIMClient } from '../modules/connectors/scim-connector/scim.client';
import { SCIMMapper } from '../modules/connectors/scim-connector/scim.mapper';
import type { SCIMConnectorConfig } from '../modules/connectors/scim-connector/scim.interface';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { createMockUser } from '@testing/mock-factories';
import type { IdentityService } from '../modules/identity/identity.service';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';

jest.mock('axios');
jest.mock('@infrastructure/url-validation/ssrf-guard', () => ({
  ...jest.requireActual('@infrastructure/url-validation/ssrf-guard'),
  validateUrlForFetch: jest.fn().mockResolvedValue(undefined),
}));

const BASE = 'https://scim.acme.example/v2';
const config: SCIMConnectorConfig = { baseUrl: BASE, authType: 'bearer', bearerToken: 't' };

interface ScimCall {
  method: string;
  path: string;
  data?: unknown;
}
type Reply = { status: number; data?: unknown; headers?: Record<string, string> };

/** The identity the activity reads the lookup identifiers from (no UPN unless given). */
const identityService = {
  findIdentityById: jest.fn(async (): Promise<unknown> => null),
};

function activitiesWith(reply: (call: ScimCall) => Reply) {
  const calls: ScimCall[] = [];
  (axios as unknown as jest.Mock).mockImplementation(
    async (req: { method: string; url: string; data?: unknown }) => {
      const call = {
        method: req.method,
        path: decodeURIComponent(req.url.slice(BASE.length).replace(/\+/g, ' ')),
        data: req.data,
      };
      calls.push(call);
      return { headers: {}, ...reply(call) };
    },
  );
  const client = new SCIMClient(
    { get: jest.fn(), set: jest.fn(), del: jest.fn() } as never,
    { execute: (_c: string, fn: () => Promise<unknown>) => fn() } as never,
  );
  const activities = new ScimActivities(
    new SCIMService(client, new SCIMMapper()),
    identityService as unknown as IdentityService,
    { emit: jest.fn() } as unknown as DomainEventEmitterService,
  );
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { activities, calls, writes };
}

const list = (users: Array<{ id: string; userName?: string; email?: string }>) => ({
  status: 200,
  data: {
    Resources: users.map(({ id, userName, email }) => ({
      id,
      userName,
      emails: email ? [{ value: email }] : undefined,
    })),
  },
});

describe('ScimActivities.deprovisionScimUser (mocked SCIM server)', () => {
  beforeEach(() => identityService.findIdentityById.mockClear());

  it('deactivates the user by its stored SCIM id', async () => {
    const { activities, writes } = activitiesWith(() => ({ status: 200, data: { id: 'scim-1' } }));

    await expect(
      activities.deprovisionScimUser(config, 'scim-1', TEST_TENANT_ID, undefined, 'ada@acme.test'),
    ).resolves.toEqual({ success: true, outcome: 'deprovisioned', detail: 'deactivated' });
    expect(writes()).toEqual([
      {
        method: 'PATCH',
        path: '/Users/scim-1',
        data: expect.objectContaining({
          Operations: [{ op: 'replace', path: 'active', value: false }],
        }),
      },
    ]);
  });

  it('deletes with deprovisionStrategy delete', async () => {
    const { activities, writes } = activitiesWith(() => ({ status: 204 }));

    await expect(
      activities.deprovisionScimUser(
        { ...config, deprovisionStrategy: 'delete' },
        'scim-1',
        TEST_TENANT_ID,
      ),
    ).resolves.toMatchObject({ outcome: 'deprovisioned', detail: 'deleted' });
    expect(writes()).toEqual([{ method: 'DELETE', path: '/Users/scim-1', data: undefined }]);
  });

  it('finds an account provisioned before the id write-back by userName, then by email', async () => {
    const byUserName = activitiesWith(({ method, path }) =>
      method === 'GET' && path.includes('userName eq "ada@acme.test"')
        ? list([{ id: 'scim-7', userName: 'ADA@acme.test' }])
        : { status: 200 },
    );
    await expect(
      byUserName.activities.deprovisionScimUser(
        config,
        undefined,
        TEST_TENANT_ID,
        undefined,
        'ada@acme.test',
      ),
    ).resolves.toMatchObject({ outcome: 'deprovisioned' });
    expect(byUserName.writes().map((c) => c.path)).toEqual(['/Users/scim-7']);

    const byEmail = activitiesWith(({ method, path }) => {
      if (method !== 'GET') return { status: 200 };
      return path.includes('emails.value eq "ada@acme.test"')
        ? list([{ id: 'scim-8', userName: 'other', email: 'ada@acme.test' }])
        : list([]);
    });
    await expect(
      byEmail.activities.deprovisionScimUser(
        config,
        undefined,
        TEST_TENANT_ID,
        undefined,
        'ada@acme.test',
      ),
    ).resolves.toMatchObject({ outcome: 'deprovisioned' });
    expect(byEmail.writes().map((c) => c.path)).toEqual(['/Users/scim-8']);
  });

  it('looks the account up by the UPN it was provisioned with, read from the identity', async () => {
    identityService.findIdentityById.mockResolvedValueOnce({
      profile: { email: 'ada@acme.test', userPrincipalName: 'ada.l@acme.onmicrosoft.example' },
    });
    const { activities, calls, writes } = activitiesWith(({ method, path }) =>
      method === 'GET' && path.includes('userName eq "ada.l@acme.onmicrosoft.example"')
        ? list([{ id: 'scim-upn', userName: 'ada.l@acme.onmicrosoft.example' }])
        : list([]),
    );

    await expect(
      activities.deprovisionScimUser(
        config,
        undefined,
        TEST_TENANT_ID,
        'wf',
        'ada@acme.test',
        'id-1',
      ),
    ).resolves.toMatchObject({ outcome: 'deprovisioned' });
    expect(identityService.findIdentityById).toHaveBeenCalledWith('id-1', { includeDeleted: true });
    expect(calls[0].path).toContain('userName eq "ada.l@acme.onmicrosoft.example"');
    expect(writes().map((c) => c.path)).toEqual(['/Users/scim-upn']);
  });

  it('ignores a returned user that does not match the filter (a server ignoring it)', async () => {
    const { activities, writes } = activitiesWith(({ method }) =>
      method === 'GET'
        ? list([{ id: 'scim-other', userName: 'bo@acme.test', email: 'bo@acme.test' }])
        : { status: 200 },
    );

    const error = await activities
      .deprovisionScimUser(config, undefined, TEST_TENANT_ID, undefined, 'ada@acme.test')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(writes()).toEqual([]);
  });

  it('fails without retry, for an admin to check, when no id is stored and no user matches', async () => {
    const none = activitiesWith(() => list([]));

    const error = await none.activities
      .deprovisionScimUser(config, undefined, TEST_TENANT_ID, undefined, 'ada@acme.test')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as Error).message).toContain('mark it removed manually');
    expect((error as Error).message).not.toContain('ada@acme.test');
    expect(none.writes()).toEqual([]);
  });

  it('reports a stored id the server no longer has (404) as already gone', async () => {
    const gone = activitiesWith(() => ({ status: 404, data: { detail: 'Resource not found' } }));
    await expect(
      gone.activities.deprovisionScimUser(config, 'scim-1', TEST_TENANT_ID),
    ).resolves.toMatchObject({ outcome: 'already-gone' });
    expect(identityService.findIdentityById).not.toHaveBeenCalled();
  });

  it('fails without retry when the token is rejected (401)', async () => {
    const { activities } = activitiesWith(() => ({
      status: 401,
      data: { detail: 'Unauthorized' },
    }));

    const error = await activities
      .deprovisionScimUser(config, 'scim-1', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('waits the retry-after of a 429', async () => {
    const { activities } = activitiesWith(() => ({ status: 429, headers: { 'retry-after': '5' } }));

    const error = await activities
      .deprovisionScimUser(config, 'scim-1', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitedException);
    expect((error as RateLimitedException).retryAfterMs).toBe(5000);
  });
});

describe('ScimActivities.provisionUserToScim (mocked SCIM server)', () => {
  it('returns the SCIM id as objectId for the onboarding writeback', async () => {
    const { activities } = activitiesWith(({ method }) =>
      method === 'GET' ? list([]) : { status: 201, data: { id: 'scim-new' } },
    );

    await expect(
      activities.provisionUserToScim(config, createMockUser(), TEST_TENANT_ID),
    ).resolves.toEqual({ success: true, targetUserId: 'scim-new', objectId: 'scim-new' });
  });
});
