/**
 * ServiceNow offboarding through the real activity, service and client against a mocked
 * ServiceNow Table API (axios mocked): deactivate and lock the sys_user record, already gone,
 * auth failure, rate limit. Untested against a live ServiceNow instance.
 */
import axios from 'axios';
import { ApplicationFailure } from '@temporalio/common';
import { ServiceNowActivities } from './servicenow.activities';
import { ServiceNowService } from '../modules/connectors/servicenow-connector/servicenow.service';
import { ServiceNowClient } from '../modules/connectors/servicenow-connector/servicenow.client';
import type { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import { ConnectorConfigDecryptError } from '../modules/connectors/connector-config.errors';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { fakeHttp, httpError, type FakeHttpCall } from '@testing/fake-http';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import type { DomainEventType } from '@infrastructure/events/event-types';

jest.mock('axios');

const config = {
  instanceUrl: 'https://acme.service-now.example',
  username: 'euroid-integration',
  password: 'secret',
};
const USER_TABLE = '/api/now/table/sys_user';
const active = { sys_id: 'abc123', active: 'true', locked_out: 'false' };

function activitiesWith(handler: (call: FakeHttpCall) => unknown) {
  const api = fakeHttp(handler);
  (axios.create as jest.Mock).mockReturnValue(api.instance);
  const connectorConfig = {
    getConfig: jest.fn().mockResolvedValue({ config }),
  } as unknown as ConnectorConfigService;
  const eventEmitter = { emit: jest.fn() };
  const activities = new ServiceNowActivities(
    new ServiceNowService(new ServiceNowClient(), connectorConfig),
    eventEmitter as unknown as DomainEventEmitterService,
  );
  return { api, activities, connectorConfig, eventEmitter };
}

describe('ServiceNowActivities.deprovisionServiceNowUser', () => {
  it('deactivates and locks the record with the stored id, never deleting it', async () => {
    const { api, activities } = activitiesWith(({ method }) =>
      method === 'GET' ? { result: active } : { result: { ...active, active: 'false' } },
    );

    await expect(
      activities.deprovisionServiceNowUser('snow-abc123', 'ada@acme.test', TEST_TENANT_ID),
    ).resolves.toEqual({ outcome: 'deprovisioned', detail: 'deactivated and locked' });
    expect(api.calls[0]).toMatchObject({ method: 'GET', url: `${USER_TABLE}/abc123` });
    expect(api.writes()).toEqual([
      {
        method: 'PATCH',
        url: `${USER_TABLE}/abc123`,
        data: { active: 'false', locked_out: 'true' },
      },
    ]);
  });

  it('finds the record by email when no id is stored, escaping the encoded query', async () => {
    const { api, activities } = activitiesWith(({ method, params }) => {
      if (method === 'GET') {
        return params?.sysparm_query === 'email=ada^^x@acme.test'
          ? { result: [active] }
          : { result: [] };
      }
      return { result: active };
    });

    await expect(
      activities.deprovisionServiceNowUser(undefined, 'ada^x@acme.test', TEST_TENANT_ID),
    ).resolves.toMatchObject({ outcome: 'deprovisioned' });
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0].url).toBe(`${USER_TABLE}/abc123`);
  });

  it('falls back to user_name when no record has the email', async () => {
    const { api, activities } = activitiesWith(({ method, params }) => {
      if (method === 'GET') {
        return params?.sysparm_query === 'user_name=ada@acme.test'
          ? { result: [active] }
          : { result: [] };
      }
      return { result: active };
    });

    await expect(
      activities.deprovisionServiceNowUser(undefined, 'ada@acme.test', TEST_TENANT_ID),
    ).resolves.toMatchObject({ outcome: 'deprovisioned' });
    expect(api.calls.filter((c) => c.method === 'GET').map((c) => c.params?.sysparm_query)).toEqual(
      ['email=ada@acme.test', 'user_name=ada@acme.test'],
    );
    expect(api.writes()[0].url).toBe(`${USER_TABLE}/abc123`);
  });

  it('fails without retry, for an admin to check, when no id is stored and nothing matches', async () => {
    const { api, activities } = activitiesWith(() => ({ result: [] }));

    const error = await activities
      .deprovisionServiceNowUser(undefined, 'ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as Error).message).toContain('mark it removed manually');
    expect(api.writes()).toEqual([]);
  });

  it('reports a missing or already inactive and locked record as already gone', async () => {
    const missing = activitiesWith(({ url }) => {
      if (url === `${USER_TABLE}/abc123`) throw httpError(404);
      return { result: [] };
    });
    await expect(
      missing.activities.deprovisionServiceNowUser('snow-abc123', 'ada@acme.test', TEST_TENANT_ID),
    ).resolves.toEqual({ outcome: 'already-gone', detail: 'no sys_user record' });
    expect(missing.api.writes()).toEqual([]);

    const locked = activitiesWith(() => ({
      result: { sys_id: 'abc123', active: 'false', locked_out: 'true' },
    }));
    await expect(
      locked.activities.deprovisionServiceNowUser('abc123', 'ada@acme.test', TEST_TENANT_ID),
    ).resolves.toMatchObject({ outcome: 'already-gone' });
    expect(locked.api.writes()).toEqual([]);
  });

  it('fails without retry when two records share the email', async () => {
    const { api, activities } = activitiesWith(() => ({
      result: [active, { ...active, sys_id: 'def456' }],
    }));

    const error = await activities
      .deprovisionServiceNowUser(undefined, 'ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect(api.writes()).toEqual([]);
  });

  it('fails without retry on rejected credentials and masks the email in the reason', async () => {
    const { activities } = activitiesWith(() => {
      throw Object.assign(httpError(401), { message: 'Unauthorized for ada@acme.test' });
    });

    const error = await activities
      .deprovisionServiceNowUser(undefined, 'ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain('ada@acme.test');
  });

  it('waits the retry-after of a 429 instead of sleeping in the client', async () => {
    const { activities } = activitiesWith(() => {
      throw httpError(429, { 'retry-after': '12' });
    });

    const error = await activities
      .deprovisionServiceNowUser('abc123', 'ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitedException);
    expect((error as RateLimitedException).retryAfterMs).toBe(12_000);
  });

  it('lets a server error through for Temporal to retry', async () => {
    const { activities } = activitiesWith(() => {
      throw httpError(503);
    });

    const error = await activities
      .deprovisionServiceNowUser('abc123', 'ada@acme.test', TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect((error as Error).message).toMatch(/^servicenow: /);
  });
});

describe('ServiceNowActivities onboarding (checkServiceNowHealth, provisionUserToServiceNow)', () => {
  const user = {
    email: 'ada@acme.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
  } as never;
  const INCIDENT_TABLE = '/api/now/table/incident';

  it('creates the sys_user record, opens a tracking incident and returns snow-<sys_id>', async () => {
    const { api, activities } = activitiesWith(({ method, url }) => {
      if (method === 'GET') return { result: [] };
      if (url === USER_TABLE) return { result: { sys_id: 'new123' } };
      return { result: { sys_id: 'inc1', number: 'INC0001' } };
    });

    await expect(
      activities.provisionUserToServiceNow(user, { operations: [] }, undefined, TEST_TENANT_ID),
    ).resolves.toEqual({
      success: true,
      objectId: 'snow-new123',
      detail: 'sys_user created or updated, tracking incident opened',
    });
    expect(api.writes().map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'POST', url: USER_TABLE },
      { method: 'POST', url: INCIDENT_TABLE },
    ]);
    expect(api.writes()[0].data).toMatchObject({
      email: 'ada@acme.test',
      user_name: 'ada@acme.test',
      active: 'true',
    });
  });

  it('updates the record that already has the email instead of creating another', async () => {
    const { api, activities } = activitiesWith(({ method, url }) => {
      // No open tracking incident of this event yet
      if (method === 'GET' && url === INCIDENT_TABLE) return { result: [] };
      if (method === 'GET') return { result: [active] };
      if (url === INCIDENT_TABLE) return { result: { sys_id: 'inc1', number: 'INC0001' } };
      return { result: active };
    });

    await expect(
      activities.provisionUserToServiceNow(user, undefined, undefined, TEST_TENANT_ID),
    ).resolves.toMatchObject({ objectId: 'snow-abc123' });
    expect(api.writes().map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'PATCH', url: `${USER_TABLE}/abc123` },
      { method: 'POST', url: INCIDENT_TABLE },
    ]);
  });

  it('fails with the email masked, for Temporal to retry, when ServiceNow rejects the write', async () => {
    const { activities } = activitiesWith(({ method }) => {
      if (method === 'GET') return { result: [] };
      throw Object.assign(httpError(500), { message: 'insert failed for ada@acme.test' });
    });

    const error = await activities
      .provisionUserToServiceNow(user, undefined, undefined, TEST_TENANT_ID)
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect((error as Error).message).toMatch(/^servicenow: /);
    expect((error as Error).message).toContain('a•••@acme.test');
    expect((error as Error).message).not.toContain('ada@acme.test');
  });

  it('reports health from the instance with the saved credentials', async () => {
    const healthy = activitiesWith(() => ({ result: [] }));
    await expect(healthy.activities.checkServiceNowHealth(undefined, TEST_TENANT_ID)).resolves.toBe(
      true,
    );

    const down = activitiesWith(() => {
      throw httpError(503);
    });
    await expect(down.activities.checkServiceNowHealth(undefined, TEST_TENANT_ID)).resolves.toBe(
      false,
    );
  });

  it('fails the health check (retried), never unhealthy, when the config cannot be decrypted', async () => {
    const { api, activities, connectorConfig } = activitiesWith(() => ({ result: [] }));
    (connectorConfig.getConfig as jest.Mock).mockRejectedValue(
      new ConnectorConfigDecryptError('servicenow'),
    );

    await expect(
      activities.checkServiceNowHealth(undefined, TEST_TENANT_ID),
    ).rejects.toBeInstanceOf(ConnectorConfigDecryptError);
    expect(api.calls).toEqual([]);
  });
});

// Plan item: ServiceNow provisioning never showed as provisioned or failed on the timeline
describe('ServiceNowActivities events (audit log, identity timeline)', () => {
  const user = {
    _id: 'id-1',
    email: 'ada@acme.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
  } as never;

  it("emits provisioning.completed under the identity's id, with the sys_user id and no email", async () => {
    const { activities, eventEmitter } = activitiesWith(({ method, url }) => {
      if (method === 'GET') return { result: [] };
      if (url === USER_TABLE) return { result: { sys_id: 'new123' } };
      return { result: { sys_id: 'inc1', number: 'INC0001' } };
    });

    await activities.provisionUserToServiceNow(user, undefined, undefined, TEST_TENANT_ID);

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    const [type, aggregateId, payload] = eventEmitter.emit.mock.calls[0];
    expect([type, aggregateId]).toEqual(['provisioning.completed', 'id-1']);
    expect(payload).toEqual({
      identityId: 'id-1',
      connector: 'servicenow',
      targetUserId: 'snow-new123',
      operations: [],
      detail: 'sys_user created or updated, tracking incident opened',
      durationMs: expect.any(Number),
    });
    expect(EVENT_SCHEMAS[type as DomainEventType]!.parse(payload)).toEqual(payload);
  });

  it('emits provisioning.failed with the masked reason', async () => {
    const { activities, eventEmitter } = activitiesWith(({ method }) => {
      if (method === 'GET') return { result: [] };
      throw Object.assign(httpError(500), { message: 'insert failed for ada@acme.test' });
    });

    await expect(
      activities.provisionUserToServiceNow(user, undefined, undefined, TEST_TENANT_ID),
    ).rejects.toThrow();

    const [type, aggregateId, payload] = eventEmitter.emit.mock.calls[0];
    expect([type, aggregateId]).toEqual(['provisioning.failed', 'id-1']);
    expect(payload).toMatchObject({ identityId: 'id-1', connector: 'servicenow', retryable: true });
    expect(payload.error).toContain('a•••@acme.test');
    expect(JSON.stringify(payload)).not.toContain('ada@acme.test');
  });

  it('records a deactivation for the audit log under the identity the caller names', async () => {
    const { activities, eventEmitter } = activitiesWith(({ method }) =>
      method === 'GET' ? { result: active } : { result: { ...active, active: 'false' } },
    );

    await activities.deprovisionServiceNowUser(
      'snow-abc123',
      'ada@acme.test',
      TEST_TENANT_ID,
      'wf-1',
      'id-1',
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith('provisioning.deprovisioned', 'id-1', {
      identityId: 'id-1',
      connector: 'servicenow',
      targetUserId: 'snow-abc123',
      detail: 'deactivated and locked',
    });
  });
});
