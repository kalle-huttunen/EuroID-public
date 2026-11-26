/**
 * Okta health check, discovery, offboarding and account id write-back through the real activity,
 * service and client against a mocked Okta API (axios mocked). Untested against a live Okta org.
 */
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { ApplicationFailure } from '@temporalio/common';
import { OktaActivities } from './okta.activities';
import { OktaService } from '../modules/connectors/okta-connector/okta.service';
import { OktaClient } from '../modules/connectors/okta-connector/okta.client';
import { OktaMapper } from '../modules/connectors/okta-connector/okta.mapper';
import { OktaDiscoveryService } from '../modules/connectors/okta-connector/okta-discovery.service';
import { OktaProvisioningService } from '../modules/connectors/okta-connector/okta-provisioning.service';
import type { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { fakeHttp, httpError, type FakeHttpCall } from '@testing/fake-http';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { createMockUser } from '@testing/mock-factories';

jest.mock('axios');

function activitiesWith(
  handler: (call: FakeHttpCall) => unknown,
  deprovisionStrategy?: 'deactivate' | 'delete',
) {
  const api = fakeHttp(handler);
  (axios.create as jest.Mock).mockReturnValue(api.instance);
  const client = new OktaClient();
  const connectorConfig = {
    getConfig: jest.fn().mockResolvedValue({
      config: { orgUrl: 'https://acme.okta.example', apiToken: 'ssws-test', deprovisionStrategy },
    }),
  } as unknown as ConnectorConfigService;
  const service = new OktaService(
    new OktaDiscoveryService(client),
    new OktaProvisioningService(client, new OktaMapper()),
    connectorConfig,
    { get: jest.fn() } as unknown as ConfigService,
  );
  const emit = jest.fn();
  const catalog = { absorbDiscovered: jest.fn().mockResolvedValue(undefined) };
  const activities = new OktaActivities(
    service,
    { emit } as unknown as DomainEventEmitterService,
    catalog as unknown as EntitlementCatalogService,
  );
  return { api, activities, emit, catalog };
}

describe('OktaActivities.checkOktaHealth', () => {
  it("reports Okta healthy from the org lookup, with the tenant's saved org and token", async () => {
    const { api, activities } = activitiesWith(() => ({ id: '00o1' }));

    await expect(activities.checkOktaHealth(undefined, TEST_TENANT_ID)).resolves.toBe(true);
    expect(api.calls).toEqual([{ method: 'GET', url: '/org', params: undefined }]);
    expect((axios.create as jest.Mock).mock.lastCall?.[0]).toMatchObject({
      baseURL: 'https://acme.okta.example/api/v1',
      headers: { Authorization: 'SSWS ssws-test' },
    });
  });

  it('reports Okta unhealthy when it rejects the API token (401)', async () => {
    const { activities } = activitiesWith(() => {
      throw httpError(401);
    });

    await expect(activities.checkOktaHealth(undefined, TEST_TENANT_ID)).resolves.toBe(false);
  });
});

describe('OktaActivities.discoverOktaEntitlements', () => {
  it('returns the groups and applications, and adds only the groups to the catalog', async () => {
    const { activities, catalog } = activitiesWith(({ url }) => {
      if (url === '/groups?limit=200') return [{ id: '00g1', profile: { name: 'Engineers' } }];
      if (url === '/apps?limit=200') return [{ id: '0oa1', name: 'slack', label: 'Slack' }];
      throw httpError(404);
    });

    await expect(activities.discoverOktaEntitlements(undefined, TEST_TENANT_ID)).resolves.toEqual([
      { nativeId: '00g1', name: 'Engineers', type: 'Group', system: 'okta' },
      { nativeId: '0oa1', name: 'Slack', type: 'Application', system: 'okta' },
    ]);
    expect(catalog.absorbDiscovered).toHaveBeenCalledWith('okta', [
      {
        nativeId: '00g1',
        name: 'Engineers',
        type: 'Group',
        system: 'okta',
        origin: 'EXTERNAL',
        governanceLevel: 'OPEN',
      },
    ]);
  });
});

describe('OktaActivities.deprovisionOktaUser', () => {
  it('deactivates the user by its stored id and leaves it in Okta (default strategy)', async () => {
    const { api, activities } = activitiesWith(() => ({}));

    await expect(
      activities.deprovisionOktaUser('00u1', 'ada@acme.test', TEST_TENANT_ID),
    ).resolves.toEqual({ outcome: 'deprovisioned', detail: 'deactivated' });
    expect(api.writes()).toEqual([{ method: 'POST', url: '/users/00u1/lifecycle/deactivate' }]);
  });

  it('deactivates and then deletes with deprovisionStrategy delete', async () => {
    const { api, activities } = activitiesWith(() => ({}), 'delete');

    await expect(
      activities.deprovisionOktaUser('00u1', 'ada@acme.test', TEST_TENANT_ID),
    ).resolves.toEqual({ outcome: 'deprovisioned', detail: 'deactivated and deleted' });
    expect(api.writes().map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /users/00u1/lifecycle/deactivate',
      'DELETE /users/00u1',
    ]);
  });

  it('looks the user up by login when no id was written back', async () => {
    const { api, activities } = activitiesWith(({ method }) =>
      method === 'GET' ? { id: '00u9', status: 'ACTIVE' } : {},
    );

    await expect(
      activities.deprovisionOktaUser(undefined, 'ada@acme.test', TEST_TENANT_ID),
    ).resolves.toMatchObject({ outcome: 'deprovisioned' });
    expect(api.calls[0]).toMatchObject({ method: 'GET', url: '/users/ada%40acme.test' });
    expect(api.writes()).toEqual([{ method: 'POST', url: '/users/00u9/lifecycle/deactivate' }]);
  });

  it('records a deactivation for the audit log under the identity the caller names', async () => {
    const { activities, emit } = activitiesWith(() => ({}));

    await activities.deprovisionOktaUser('00u1', 'ada@acme.test', TEST_TENANT_ID, 'wf-1', 'id-1');

    expect(emit).toHaveBeenCalledTimes(1);
    const [type, aggregateId, payload] = emit.mock.calls[0];
    expect([type, aggregateId]).toEqual([DomainEventType.PROVISIONING_DEPROVISIONED, 'id-1']);
    expect(payload).toEqual({
      identityId: 'id-1',
      connector: 'okta',
      targetUserId: '00u1',
      detail: 'deactivated',
    });
    expect(EVENT_SCHEMAS[DomainEventType.PROVISIONING_DEPROVISIONED]!.parse(payload)).toEqual(
      payload,
    );
  });

  it('reports a stored id Okta no longer has (404) as already gone', async () => {
    const deactivate = activitiesWith(() => {
      throw httpError(404);
    }, 'delete');
    await expect(
      deactivate.activities.deprovisionOktaUser('00u1', 'ada@acme.test', TEST_TENANT_ID),
    ).resolves.toEqual({ outcome: 'already-gone', detail: 'no such user' });
  });

  it('fails without retry, for an admin to check, when no id is stored and the login is not found', async () => {
    const lookup = activitiesWith(() => {
      throw httpError(404);
    });

    const error = await lookup.activities
      .deprovisionOktaUser(undefined, 'ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as Error).message).toContain('mark it removed manually');
    expect((error as Error).message).not.toContain('ada@acme.test');
    expect(lookup.api.writes()).toEqual([]);
  });

  it('fails without retry when the API token is rejected (401)', async () => {
    const { activities } = activitiesWith(() => {
      throw httpError(401);
    });

    const error = await activities
      .deprovisionOktaUser('00u1', 'ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as Error).message).toContain('HTTP 401');
  });

  it('waits the retry-after when Okta still rate-limits after its own retry (429)', async () => {
    const { api, activities } = activitiesWith(() => {
      throw httpError(429, { 'retry-after': '0' });
    });

    const error = await activities
      .deprovisionOktaUser('00u1', 'ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitedException);
    expect(api.calls).toHaveLength(2); // the status read and the client's one immediate retry
    expect(api.writes()).toEqual([]);
  });

  describe('a rerun: the user is already deactivated (status read first)', () => {
    const deprovisioned = ({ method }: FakeHttpCall) =>
      method === 'GET' ? { id: '00u1', status: 'DEPROVISIONED' } : {};

    it('does not deactivate it again: already gone', async () => {
      const { api, activities } = activitiesWith(deprovisioned);

      await expect(
        activities.deprovisionOktaUser('00u1', 'ada@acme.test', TEST_TENANT_ID),
      ).resolves.toEqual({ outcome: 'already-gone', detail: 'already deactivated' });
      expect(api.calls).toEqual([{ method: 'GET', url: '/users/00u1', params: undefined }]);
    });

    it('with deprovisionStrategy delete only deletes it', async () => {
      const { api, activities } = activitiesWith(deprovisioned, 'delete');

      await expect(
        activities.deprovisionOktaUser('00u1', 'ada@acme.test', TEST_TENANT_ID),
      ).resolves.toEqual({ outcome: 'deprovisioned', detail: 'deleted (was already deactivated)' });
      expect(api.writes()).toEqual([{ method: 'DELETE', url: '/users/00u1', params: undefined }]);
    });
  });
});

describe('OktaActivities.provisionUserToOkta', () => {
  it('returns the Okta user id as objectId for the onboarding writeback', async () => {
    const { activities } = activitiesWith(({ method, url }) =>
      method === 'POST' && url.startsWith('/users?') ? { id: '00u7', status: 'ACTIVE' } : {},
    );

    await expect(
      activities.provisionUserToOkta(createMockUser(), undefined, undefined, TEST_TENANT_ID),
    ).resolves.toMatchObject({ success: true, oktaUserId: '00u7', objectId: '00u7' });
  });

  describe('its provisioning events (audit log, timeline, websocket)', () => {
    const emitted = (emit: jest.Mock, type: DomainEventType) => {
      const calls = emit.mock.calls.filter(([t]) => t === type);
      expect(calls).toHaveLength(1);
      const [, aggregateId, payload] = calls[0] as [string, string, Record<string, unknown>];
      expect(EVENT_SCHEMAS[type]!.parse(payload)).toEqual(payload);
      return { aggregateId, payload };
    };

    it("go under the identity's id", async () => {
      const { activities, emit } = activitiesWith(({ method, url }) =>
        method === 'POST' && url.startsWith('/users?') ? { id: '00u7', status: 'ACTIVE' } : {},
      );

      await activities.provisionUserToOkta(
        createMockUser({ _id: 'id-1' }),
        undefined,
        undefined,
        TEST_TENANT_ID,
      );

      const { aggregateId, payload } = emitted(emit, DomainEventType.PROVISIONING_COMPLETED);
      expect(aggregateId).toBe('id-1');
      expect(payload).toMatchObject({
        identityId: 'id-1',
        connector: 'okta',
        targetUserId: '00u7',
      });
    });

    it('carry no identity id and no email for a profile without an id, a failure included', async () => {
      const { activities, emit } = activitiesWith(() => {
        throw Object.assign(httpError(400), { message: 'login john.doe@example.com is invalid' });
      });

      await expect(
        activities.provisionUserToOkta(
          createMockUser({ _id: undefined }),
          undefined,
          undefined,
          TEST_TENANT_ID,
        ),
      ).rejects.toThrow();

      const { aggregateId, payload } = emitted(emit, DomainEventType.PROVISIONING_FAILED);
      expect(aggregateId).toBe('okta');
      expect(payload).not.toHaveProperty('identityId');
      expect(JSON.stringify(payload)).not.toContain('john.doe@example.com');
    });
  });
});

// Hunt 2026-11-25 (01 F15): disableOktaUser answered false for every error, though its contract
// says false only for a user Okta does not have. A failed deactivation (Okta down, a refused
// token) now fails the activity, so Temporal retries it, and a missing user counts as gone.
describe('OktaActivities.disableOktaUser', () => {
  it('deactivates the user', async () => {
    const { api, activities } = activitiesWith(() => ({}));

    await expect(activities.disableOktaUser('00u1', undefined, TEST_TENANT_ID)).resolves.toBe(true);
    expect(api.calls).toEqual([
      { method: 'POST', url: '/users/00u1/lifecycle/deactivate', params: undefined },
    ]);
  });

  it('fails, never answering "not deactivated", when Okta cannot be asked', async () => {
    const { activities } = activitiesWith(() => {
      throw httpError(503);
    });

    await expect(activities.disableOktaUser('00u1', undefined, TEST_TENANT_ID)).rejects.toThrow();
  });

  it('answers true for a user Okta does not have: nothing is left to deactivate', async () => {
    const { activities } = activitiesWith(() => {
      throw httpError(404);
    });

    await expect(activities.disableOktaUser('00u1', undefined, TEST_TENANT_ID)).resolves.toBe(true);
  });
});
