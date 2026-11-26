/**
 * GitHub offboarding through the real activity, service and client against a mocked GitHub API
 * (axios mocked): cancel a pending invitation, already gone, auth failure, rate limits.
 * Untested against a live GitHub organization.
 */
import axios from 'axios';
import { ApplicationFailure } from '@temporalio/common';
import { GitHubActivities } from './github.activities';
import { GitHubService } from '../modules/connectors/github-connector/github.service';
import { GitHubClient } from '../modules/connectors/github-connector/github.client';
import type { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import { ConnectorConfigDecryptError } from '../modules/connectors/connector-config.errors';
import type { IdentityService } from '../modules/identity/identity.service';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { fakeHttp, httpError, type FakeHttpCall } from '@testing/fake-http';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import type { DomainEventType } from '@infrastructure/events/event-types';

jest.mock('axios');

const ORG = 'acme';
const config = { personalAccessToken: 'ghp_test', orgName: ORG };

/**
 * Real activity, service and client against the mocked GitHub API. `customAttributes`: the
 * identity's, as offboarding reads them (findIdentityById); none: no such identity.
 */
function activitiesWith(
  handler: (call: FakeHttpCall) => unknown,
  customAttributes?: Record<string, unknown>,
) {
  const api = fakeHttp(handler);
  (axios.create as jest.Mock).mockReturnValue(api.instance);
  const connectorConfig = {
    getConfig: jest.fn().mockResolvedValue({ config }),
  } as unknown as ConnectorConfigService;
  const identityService = {
    findIdentityById: jest
      .fn()
      .mockResolvedValue(customAttributes ? { profile: { customAttributes } } : null),
  };
  const eventEmitter = { emit: jest.fn() };
  const activities = new GitHubActivities(
    new GitHubService(new GitHubClient(), connectorConfig),
    identityService as unknown as IdentityService,
    eventEmitter as unknown as DomainEventEmitterService,
  );
  return { api, activities, connectorConfig, identityService, eventEmitter };
}

const invitation = (id: number, email: string) => ({ id, email, login: null });
const fullPage = (from: number) =>
  Array.from({ length: 100 }, (_, i) => invitation(from + i, `other${from + i}@acme.test`));

describe('GitHubActivities.deprovisionGitHubUser', () => {
  it('cancels the pending invitation (found on a later page, email compared without case)', async () => {
    const { api, activities } = activitiesWith(({ method, url, params }) => {
      if (method === 'GET' && url === `/orgs/${ORG}/invitations`) {
        return params?.page === 1 ? fullPage(1) : [invitation(4242, 'Ada@Acme.test')];
      }
      if (method === 'DELETE') return undefined;
      throw httpError(500);
    });

    await expect(
      activities.deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID),
    ).resolves.toEqual({ outcome: 'deprovisioned', detail: 'pending invitation cancelled' });
    expect(api.writes()).toEqual([{ method: 'DELETE', url: `/orgs/${ORG}/invitations/4242` }]);
  });

  it('reports a failed or expired invitation as already gone, changing nothing', async () => {
    const { api, activities } = activitiesWith(({ url }) =>
      url.endsWith('/failed_invitations') ? [invitation(7, 'ada@acme.test')] : [],
    );

    await expect(
      activities.deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID),
    ).resolves.toMatchObject({ outcome: 'already-gone' });
    expect(api.writes()).toEqual([]);
  });

  it('fails without retry when no invitation exists (accepted: GitHub cannot find a member by email)', async () => {
    const { api, activities } = activitiesWith(() => []);

    const error = await activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as Error).message).toMatch(/remove them from the organization in GitHub/);
    expect(api.writes()).toEqual([]);
  });

  it('retries (409) when the invitation vanished between the lookup and the cancel', async () => {
    const { activities } = activitiesWith(({ method }) => {
      if (method === 'DELETE') throw httpError(404);
      return [invitation(1, 'ada@acme.test')];
    });

    const error = await activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect((error as Error).message).toMatch(/changed while it was being cancelled/);
  });

  it('fails without retry when the token is rejected or lacks admin:org (401/403)', async () => {
    for (const status of [401, 403]) {
      const { activities } = activitiesWith(() => {
        throw httpError(status, { 'x-ratelimit-remaining': '4999' });
      });
      const error = await activities
        .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(true);
      expect((error as Error).message).toContain(`HTTP ${status}`);
    }
  });

  it('waits out a rate limit: 429 retry-after, and 403 with the primary limit used up', async () => {
    const limited = activitiesWith(() => {
      throw httpError(429, { 'retry-after': '30' });
    });
    const error = await limited.activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedException);
    expect((error as RateLimitedException).retryAfterMs).toBe(30_000);

    const resetAt = Math.floor(Date.now() / 1000) + 120;
    const exhausted = activitiesWith(() => {
      throw httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) });
    });
    const primary = await exhausted.activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);
    expect(primary).toBeInstanceOf(RateLimitedException);
    expect((primary as RateLimitedException).retryAfterMs).toBeGreaterThan(100_000);
  });

  it('fails without retry when the GitHub connector is not configured', async () => {
    const { activities, connectorConfig } = activitiesWith(() => []);
    (connectorConfig.getConfig as jest.Mock).mockResolvedValue(null);

    const error = await activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
  });
});

/** The axios look-alike answers 201 to POST, as GitHub does for a created invitation. */
function withCreatedStatus(api: ReturnType<typeof fakeHttp>) {
  const post = api.instance.post;
  api.instance.post = async (url: string, data?: unknown) => ({
    ...(await post(url, data)),
    status: 201,
  });
}

describe('GitHubActivities onboarding (checkGitHubHealth, provisionUserToGitHub)', () => {
  const user = { email: 'ada@acme.test', firstName: 'Ada', lastName: 'Lovelace' } as never;

  it('invites by email and returns the invitation id for the write-back', async () => {
    const { api, activities } = activitiesWith(() => ({ id: 4242, email: 'ada@acme.test' }));
    withCreatedStatus(api);

    await expect(
      activities.provisionUserToGitHub(user, { operations: [] }, undefined, TEST_TENANT_ID),
    ).resolves.toEqual({
      success: true,
      objectId: 'github-invitation-4242',
      detail: 'organization invitation sent',
    });
    expect(api.writes()).toEqual([
      {
        method: 'POST',
        url: `/orgs/${ORG}/invitations`,
        data: { invitee_id: null, email: 'ada@acme.test', role: 'direct_member' },
      },
    ]);
  });

  it('treats an existing invitation or membership (422) as success without an id', async () => {
    const { activities } = activitiesWith(() => {
      throw httpError(422, {}, { message: 'Invitee is already a member of this organization' });
    });

    const result = await activities.provisionUserToGitHub(
      user,
      undefined,
      undefined,
      TEST_TENANT_ID,
    );

    expect(result).toEqual({ success: true, detail: 'already invited or a member' });
    expect(result).not.toHaveProperty('objectId');
  });

  // Hunt 2026-11-25 (r2-01 N9): GitHub answers an invite it refuses with 422 "Validation Failed"
  // and the reason in errors[], so matching the top-level message missed an existing invitation
  // and a repeated invite threw. A pending invitation for the email now counts as success.
  it('treats a 422 as success when the organization has a pending invitation for the email', async () => {
    const { activities } = activitiesWith(({ method, url }) => {
      if (method === 'POST') {
        throw httpError(
          422,
          {},
          { message: 'Validation Failed', errors: [{ code: 'unprocessable', field: 'data' }] },
        );
      }
      if (method === 'GET' && url === `/orgs/${ORG}/invitations`) {
        return [invitation(77, 'Ada@acme.test')];
      }
      throw httpError(500);
    });

    await expect(
      activities.provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID),
    ).resolves.toEqual({ success: true, detail: 'already invited or a member' });
  });

  it("reads GitHub's reason from errors[] when the 422 names a member", async () => {
    const { activities } = activitiesWith(({ method }) => {
      if (method === 'POST') {
        throw httpError(
          422,
          {},
          {
            message: 'Validation Failed',
            errors: [{ message: 'Invitee is already a part of this organization' }],
          },
        );
      }
      return [];
    });

    await expect(
      activities.provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID),
    ).resolves.toEqual({ success: true, detail: 'already invited or a member' });
  });

  it('fails with the email masked when GitHub rejects the call, so Temporal retries it', async () => {
    const { activities } = activitiesWith(() => {
      throw Object.assign(httpError(500), { message: 'invite ada@acme.test failed' });
    });

    const error = await activities
      .provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect((error as Error).message).toBe('github: invite a•••@acme.test failed');
  });

  it('waits out a rate limit on the email invitation: 429, and 403 with retry-after or the primary limit used up', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 120;
    const answers: Array<[number, Record<string, string>, (ms: number) => void]> = [
      [429, { 'retry-after': '30' }, (ms) => expect(ms).toBe(30_000)],
      [403, { 'retry-after': '60' }, (ms) => expect(ms).toBe(60_000)],
      [
        403,
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
        (ms) => expect(ms).toBeGreaterThan(100_000),
      ],
    ];
    for (const [status, headers, expectWait] of answers) {
      const { activities } = activitiesWith(() => {
        throw httpError(status, headers);
      });

      const error = await activities
        .provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RateLimitedException);
      expectWait((error as RateLimitedException).retryAfterMs);
    }
  });

  it('still reports a rejected token on the email invitation as an auth failure (401, 403 not rate limited)', async () => {
    for (const status of [401, 403]) {
      const { activities } = activitiesWith(() => {
        throw httpError(status, { 'x-ratelimit-remaining': '4999' });
      });

      const error = await activities
        .provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID)
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(RateLimitedException);
      expect((error as Error).message).toBe(
        'github: GitHub auth failed. Ensure PAT has admin:org scope.',
      );
    }
  });

  it('reports health from the organization lookup with the saved token', async () => {
    const healthy = activitiesWith(() => ({ login: ORG }));
    await expect(healthy.activities.checkGitHubHealth(undefined, TEST_TENANT_ID)).resolves.toBe(
      true,
    );
    expect(healthy.api.calls).toEqual([{ method: 'GET', url: `/orgs/${ORG}` }]);

    const rejected = activitiesWith(() => {
      throw httpError(401);
    });
    await expect(rejected.activities.checkGitHubHealth(undefined, TEST_TENANT_ID)).resolves.toBe(
      false,
    );
  });

  it('is unhealthy, calling nothing, when the GitHub connector is not configured', async () => {
    const { api, activities, connectorConfig } = activitiesWith(() => ({}));
    (connectorConfig.getConfig as jest.Mock).mockResolvedValue(null);

    await expect(activities.checkGitHubHealth(undefined, TEST_TENANT_ID)).resolves.toBe(false);
    expect(api.calls).toEqual([]);
  });

  it('fails the health check (retried), never unhealthy, when the config cannot be decrypted', async () => {
    const { api, activities, connectorConfig } = activitiesWith(() => ({}));
    (connectorConfig.getConfig as jest.Mock).mockRejectedValue(
      new ConnectorConfigDecryptError('github'),
    );

    await expect(activities.checkGitHubHealth(undefined, TEST_TENANT_ID)).rejects.toBeInstanceOf(
      ConnectorConfigDecryptError,
    );
    expect(api.calls).toEqual([]);
  });

  it('requires a tenant', async () => {
    const { activities } = activitiesWith(() => ({}));
    await expect(activities.provisionUserToGitHub(user, undefined, undefined, '')).rejects.toThrow(
      /tenantId is required/,
    );
  });
});

describe('GitHubActivities.deprovisionGitHubUser with a GitHub account', () => {
  const removed = {
    outcome: 'deprovisioned',
    detail: 'removed from the organization (membership or invitation)',
  };

  it('removes the account onboarding wrote back, by its current login, without reading the identity', async () => {
    const { api, activities, identityService } = activitiesWith(({ method, url }) => {
      if (method === 'GET' && url === '/user/583231') return { id: 583231, login: 'Ada-Renamed' };
      if (method === 'DELETE') return undefined;
      throw httpError(500);
    });

    await expect(
      activities.deprovisionGitHubUser(
        'ada@acme.test',
        TEST_TENANT_ID,
        'wf-1',
        'github-user-583231',
        'id-1',
      ),
    ).resolves.toEqual(removed);
    expect(api.writes()).toEqual([
      { method: 'DELETE', url: `/orgs/${ORG}/memberships/Ada-Renamed` },
    ]);
    expect(identityService.findIdentityById).not.toHaveBeenCalled();
  });

  it("removes the identity's GitHub login when no GitHub user id was written back", async () => {
    const { api, activities, identityService } = activitiesWith(
      ({ method }) => (method === 'DELETE' ? undefined : []),
      { hrStatus: 'Terminated', githubLogin: ' ada-gh ' },
    );

    await expect(
      activities.deprovisionGitHubUser(
        'ada@acme.test',
        TEST_TENANT_ID,
        'wf-1',
        'github-invitation-4242',
        'id-1',
      ),
    ).resolves.toEqual(removed);
    expect(identityService.findIdentityById).toHaveBeenCalledWith('id-1', { includeDeleted: true });
    expect(api.calls).toEqual([{ method: 'DELETE', url: `/orgs/${ORG}/memberships/ada-gh` }]);
  });

  it('cancels an invitation sent by email before the login was known when the login is no member', async () => {
    const { api, activities } = activitiesWith(
      ({ method, url }) => {
        if (method === 'DELETE' && url.includes('/memberships/')) throw httpError(404);
        if (method === 'DELETE') return undefined;
        return url === `/orgs/${ORG}/invitations` ? [invitation(4242, 'ada@acme.test')] : [];
      },
      { githubLogin: 'ada-gh' },
    );

    await expect(
      activities.deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID, 'wf-1', undefined, 'id-1'),
    ).resolves.toEqual({ outcome: 'deprovisioned', detail: 'pending invitation cancelled' });
    expect(api.writes()).toEqual([
      { method: 'DELETE', url: `/orgs/${ORG}/memberships/ada-gh` },
      { method: 'DELETE', url: `/orgs/${ORG}/invitations/4242` },
    ]);
  });

  it('is already gone when the login is neither a member nor invited and no email invitation is pending (404)', async () => {
    const { api, activities } = activitiesWith(
      ({ method }) => {
        if (method === 'DELETE') throw httpError(404);
        return [];
      },
      { githubLogin: 'ada-gh' },
    );

    await expect(
      activities.deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID, 'wf-1', undefined, 'id-1'),
    ).resolves.toEqual({ outcome: 'already-gone', detail: 'not a member of the organization' });
    // Not the "remove them by hand" failure of the email-only path
    expect(api.calls.map((c) => c.url)).not.toContain(`/orgs/${ORG}/failed_invitations`);
  });

  it('is already gone, changing nothing, when GitHub no longer has the written-back account', async () => {
    const { api, activities } = activitiesWith(() => {
      throw httpError(404);
    });

    await expect(
      activities.deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID, 'wf-1', 'github-user-7'),
    ).resolves.toEqual({ outcome: 'already-gone', detail: 'GitHub account no longer exists' });
    expect(api.calls).toEqual([{ method: 'GET', url: '/user/7' }]);
  });

  it('keeps the email-only behaviour for an identity without a login (accepted: fails for manual removal)', async () => {
    const { api, activities } = activitiesWith(() => [], { hrStatus: 'Terminated' });

    const error = await activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID, 'wf-1', undefined, 'id-1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as Error).message).toMatch(/remove them from the organization in GitHub/);
    expect((error as Error).message).toMatch(/customAttributes\.githubLogin/);
    expect(api.writes()).toEqual([]);
  });

  it('fails without retry, calling nothing, when the identity holds something that is not a GitHub login', async () => {
    const { api, activities } = activitiesWith(() => [], { githubLogin: 'ada/../../user' });

    const error = await activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID, 'wf-1', undefined, 'id-1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as Error).message).toMatch(/customAttributes\.githubLogin is not a GitHub login/);
    expect((error as Error).message).not.toContain('ada/');
    expect(api.calls).toEqual([]);
  });

  it('waits out a rate limit on the removal and never puts the login in a failure', async () => {
    const limited = activitiesWith(
      () => {
        throw httpError(403, { 'retry-after': '45' });
      },
      { githubLogin: 'ada-gh' },
    );
    const error = await limited.activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID, 'wf-1', undefined, 'id-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedException);
    expect((error as RateLimitedException).retryAfterMs).toBe(45_000);

    const forbidden = activitiesWith(
      () => {
        throw httpError(403, { 'x-ratelimit-remaining': '4999' });
      },
      { githubLogin: 'ada-gh' },
    );
    const rejected = await forbidden.activities
      .deprovisionGitHubUser('ada@acme.test', TEST_TENANT_ID, 'wf-1', undefined, 'id-1')
      .catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ApplicationFailure);
    expect((rejected as Error).message).toContain('HTTP 403');
    expect((rejected as Error).message).not.toContain('ada-gh');
  });
});

describe('GitHubActivities.provisionUserToGitHub with a GitHub login', () => {
  const user = {
    email: 'ada@acme.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    customAttributes: { githubLogin: 'ada-gh' },
  } as never;

  it('invites the account by its user id and writes the id back', async () => {
    const { api, activities } = activitiesWith(({ method, url }) => {
      if (method === 'GET' && url === '/users/ada-gh') return { id: 583231, login: 'Ada-GH' };
      if (method === 'POST') return { id: 99, login: 'Ada-GH', email: null };
      throw httpError(500);
    });

    await expect(
      activities.provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID),
    ).resolves.toEqual({
      success: true,
      objectId: 'github-user-583231',
      detail: 'organization invitation sent to the GitHub account',
    });
    expect(api.writes()).toEqual([
      {
        method: 'POST',
        url: `/orgs/${ORG}/invitations`,
        data: { invitee_id: 583231, role: 'direct_member' },
      },
    ]);
  });

  it('treats an account already invited or a member as success, checked by its membership, and still writes the id back', async () => {
    const { api, activities } = activitiesWith(({ method, url }) => {
      if (method === 'GET' && url === '/users/ada-gh') return { id: 583231, login: 'Ada-GH' };
      if (method === 'POST') {
        throw httpError(422, {}, { message: 'Validation Failed' });
      }
      if (method === 'GET' && url === `/orgs/${ORG}/memberships/Ada-GH`) return { state: 'active' };
      throw httpError(500);
    });

    await expect(
      activities.provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID),
    ).resolves.toEqual({
      success: true,
      objectId: 'github-user-583231',
      detail: 'GitHub account already invited or a member',
    });
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /users/ada-gh',
      `POST /orgs/${ORG}/invitations`,
      `GET /orgs/${ORG}/memberships/Ada-GH`,
    ]);
  });

  it("fails (retried) with GitHub's reason on a 422 when the account is neither a member nor invited", async () => {
    const { activities } = activitiesWith(({ method, url }) => {
      if (method === 'GET' && url === '/users/ada-gh') return { id: 583231, login: 'Ada-GH' };
      if (method === 'POST') throw httpError(422, {}, { message: 'Over seat limit' });
      throw httpError(404);
    });

    const error = await activities
      .provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect((error as Error).message).toBe('github: GitHub refused the invitation: Over seat limit');
  });

  it('does not fall back to the email when GitHub has no account with the login', async () => {
    const { api, activities } = activitiesWith(() => {
      throw httpError(404);
    });

    const error = await activities
      .provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      'github: GitHub has no account with the login in customAttributes.githubLogin',
    );
    expect(api.calls).toEqual([{ method: 'GET', url: '/users/ada-gh' }]);
  });

  it('refuses, calling nothing, a login that is not a GitHub login', async () => {
    const { api, activities } = activitiesWith(() => ({}));
    const bad = { ...(user as object), customAttributes: { githubLogin: '../orgs' } } as never;

    await expect(
      activities.provisionUserToGitHub(bad, undefined, undefined, TEST_TENANT_ID),
    ).rejects.toThrow(/customAttributes\.githubLogin is not a GitHub login/);
    expect(api.calls).toEqual([]);
  });

  it("waits out GitHub's secondary rate limit on the invitation", async () => {
    const { activities } = activitiesWith(({ method }) => {
      if (method === 'GET') return { id: 583231, login: 'Ada-GH' };
      throw httpError(403, { 'retry-after': '60' });
    });

    const error = await activities
      .provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitedException);
    expect((error as RateLimitedException).retryAfterMs).toBe(60_000);
  });
});

// Plan item: GitHub provisioning never showed as provisioned or failed on the identity timeline
describe('GitHubActivities events (audit log, identity timeline)', () => {
  const user = {
    _id: 'id-1',
    email: 'ada@acme.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    customAttributes: { githubLogin: 'ada-gh' },
  } as never;

  it("emits provisioning.completed under the identity's id, with the account id and no login or email", async () => {
    const { activities, eventEmitter } = activitiesWith(({ method, url }) => {
      if (method === 'GET' && url === '/users/ada-gh') return { id: 583231, login: 'Ada-GH' };
      if (method === 'POST') return { id: 99, login: 'Ada-GH', email: null };
      throw httpError(500);
    });

    await activities.provisionUserToGitHub(user, undefined, undefined, TEST_TENANT_ID);

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    const [type, aggregateId, payload] = eventEmitter.emit.mock.calls[0];
    expect([type, aggregateId]).toEqual(['provisioning.completed', 'id-1']);
    expect(payload).toEqual({
      identityId: 'id-1',
      connector: 'github',
      targetUserId: 'github-user-583231',
      operations: [],
      detail: 'organization invitation sent to the GitHub account',
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(payload)).not.toMatch(/ada@acme\.test|ada-gh/i);
    expect(EVENT_SCHEMAS[type as DomainEventType]!.parse(payload)).toEqual(payload);
  });

  it('emits provisioning.failed with the masked reason, retryable as the thrown error', async () => {
    const { activities, eventEmitter } = activitiesWith(() => {
      throw Object.assign(httpError(500), { message: 'invite ada@acme.test failed' });
    });

    await expect(
      activities.provisionUserToGitHub(
        { ...(user as object), customAttributes: {} } as never,
        undefined,
        undefined,
        TEST_TENANT_ID,
      ),
    ).rejects.toThrow();

    expect(eventEmitter.emit).toHaveBeenCalledWith('provisioning.failed', 'id-1', {
      identityId: 'id-1',
      connector: 'github',
      error: 'github: invite a•••@acme.test failed',
      retryable: true,
    });
  });

  it('records a removal for the audit log under the identity, with the account id', async () => {
    const { activities, eventEmitter } = activitiesWith(({ method, url }) => {
      if (method === 'GET' && url === '/user/583231') return { id: 583231, login: 'Ada-GH' };
      if (method === 'DELETE') return undefined;
      throw httpError(500);
    });

    await activities.deprovisionGitHubUser(
      'ada@acme.test',
      TEST_TENANT_ID,
      'wf-1',
      'github-user-583231',
      'id-1',
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith('provisioning.deprovisioned', 'id-1', {
      identityId: 'id-1',
      connector: 'github',
      targetUserId: 'github-user-583231',
      detail: 'removed from the organization (membership or invitation)',
    });
  });
});

// Hunt 2026-11-25 (r2-01 N9): the invitation and health check paths took orgName unencoded, so a
// connector-admin's orgName could steer the token to other api.github.com paths
describe('GitHubClient: the organization in the path', () => {
  it('is one encoded path segment in the invitation and the health check', async () => {
    const api = fakeHttp(() => ({ id: 1 }));
    (axios.create as jest.Mock).mockReturnValue(api.instance);
    const client = new GitHubClient();
    const steered = { personalAccessToken: 'ghp_test', orgName: 'acme/../../user/repos' };

    await client.createInvitation(steered, 'ada@acme.test').catch(() => undefined);
    await client.healthCheck(steered);

    expect(api.calls.map((c) => c.url)).toEqual([
      '/orgs/acme%2F..%2F..%2Fuser%2Frepos/invitations',
      '/orgs/acme%2F..%2F..%2Fuser%2Frepos',
    ]);
  });
});
