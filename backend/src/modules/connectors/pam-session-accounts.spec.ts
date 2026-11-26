/**
 * Enabling and disabling a linked admin account for a privileged session, per connector, against
 * mocked protocol layers (ldapts Client, the SCIM client, axios for Okta). Untested against a
 * live domain controller, SCIM server or Okta org.
 *
 * - AD: enabling clears only ACCOUNTDISABLE (0x2) and keeps the account's other flags; disabling
 *   writes 514; a DN AD no longer knows is not-found.
 * - SCIM: `active` goes through PATCH replace active, by the stored id or found by userName.
 * - Okta: what each user status allows (suspend only ACTIVE, unsuspend only SUSPENDED).
 */
jest.mock('ldapts', () => ({
  ...jest.requireActual('ldapts'),
  Client: jest.fn(),
}));
jest.mock('@infrastructure/url-validation/ssrf-guard', () => ({
  ...jest.requireActual('@infrastructure/url-validation/ssrf-guard'),
  // AdClient connects to the address the guard answers; these specs need no DNS
  resolveHostForConnect: jest.fn(async (host: string) => ({ address: host })),
}));
jest.mock('axios');

import axios from 'axios';
import { Client, NoSuchObjectError } from 'ldapts';
import { httpError } from '@testing/fake-http';
import { SCIM_SCHEMAS, SCIMError } from '@shared/scim';
import { AdClient } from './ad-connector/ad.client';
import { AdService } from './ad-connector/ad.service';
import type { AdConfig } from './ad-connector/ad.interface';
import { SCIMService } from './scim-connector/scim.service';
import type { SCIMClient } from './scim-connector/scim.client';
import { SCIMMapper } from './scim-connector/scim.mapper';
import type { SCIMConnectorConfig } from './scim-connector/scim.interface';
import { OktaClient } from './okta-connector/okta.client';
import { OktaMapper } from './okta-connector/okta.mapper';
import { OktaProvisioningService } from './okta-connector/okta-provisioning.service';
import type { OktaConfig } from './okta-connector/okta.interface';

const DN = 'CN=adm-ada,OU=Admins,DC=acme,DC=test';

describe('AD: a privileged session enables and disables by DN', () => {
  const config: AdConfig = {
    host: 'dc.acme.test',
    rootBaseDn: 'DC=acme,DC=test',
    serviceAccount: 'CN=svc,DC=acme,DC=test',
    password: 'secret',
  };

  function setup(userAccountControl?: string) {
    const ldap = {
      bind: jest.fn().mockResolvedValue(undefined),
      unbind: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue({
        searchEntries: [{ dn: DN, ...(userAccountControl ? { userAccountControl } : {}) }],
      }),
      modify: jest.fn().mockResolvedValue(undefined),
    };
    (Client as unknown as jest.Mock).mockImplementation(() => ldap);
    return { ldap, service: new AdService(new AdClient()) };
  }

  const written = (ldap: { modify: jest.Mock }) => {
    const change = ldap.modify.mock.calls[0][1] as {
      operation: string;
      modification: { type: string; values: string[] };
    };
    return [change.operation, change.modification.type, change.modification.values];
  };

  it('clears ACCOUNTDISABLE and keeps the other flags', async () => {
    // 66050 = NORMAL_ACCOUNT | ACCOUNTDISABLE | DONT_EXPIRE_PASSWD
    const { ldap, service } = setup('66050');

    await expect(service.setUserEnabled(config, DN, true)).resolves.toEqual({
      outcome: 'done',
      detail: 'enabled',
    });

    expect(ldap.search).toHaveBeenCalledWith(DN, expect.objectContaining({ scope: 'base' }));
    expect(written(ldap)).toEqual(['replace', 'userAccountControl', ['66048']]);
    expect(ldap.unbind).toHaveBeenCalled();
  });

  it('writes 512 when the account has no readable userAccountControl', async () => {
    const { ldap, service } = setup();
    await service.setUserEnabled(config, DN, true);
    expect(written(ldap)).toEqual(['replace', 'userAccountControl', ['512']]);
  });

  it('disables with 514', async () => {
    const { ldap, service } = setup('512');
    await expect(service.setUserEnabled(config, DN, false)).resolves.toEqual({
      outcome: 'done',
      detail: 'disabled',
    });
    expect(written(ldap)).toEqual(['replace', 'userAccountControl', ['514']]);
  });

  it('answers not-found for a DN AD no longer knows', async () => {
    const { ldap, service } = setup('514');
    ldap.search.mockRejectedValue(new NoSuchObjectError('no such object'));
    await expect(service.setUserEnabled(config, DN, true)).resolves.toEqual({
      outcome: 'not-found',
      detail: 'no such object',
    });
    expect(ldap.modify).not.toHaveBeenCalled();
  });
});

describe('SCIM: a privileged session sets active through PATCH', () => {
  const config: SCIMConnectorConfig = {
    baseUrl: 'https://api.example.com/scim/v2',
    authType: 'bearer',
    bearerToken: 'test-token',
  };
  const patchActive = (value: boolean) => ({
    schemas: [SCIM_SCHEMAS.PATCH_OP],
    Operations: [{ op: 'replace', path: 'active', value }],
  });

  function setup() {
    const client = {
      patchUser: jest.fn().mockResolvedValue({}),
      listUsers: jest.fn(),
    };
    const service = new SCIMService(client as unknown as SCIMClient, new SCIMMapper());
    return { client, service };
  }

  it('patches active by the stored id', async () => {
    const { client, service } = setup();

    await expect(service.setActive(config, { id: 'scim-7' }, true)).resolves.toEqual({
      outcome: 'done',
      detail: 'activated',
    });
    await service.setActive(config, { id: 'scim-7' }, false);

    expect(client.patchUser.mock.calls).toEqual([
      [config, 'scim-7', patchActive(true)],
      [config, 'scim-7', patchActive(false)],
    ]);
    expect(client.listUsers).not.toHaveBeenCalled();
  });

  it('finds the user by userName without a stored id, and only one that matches', async () => {
    const { client, service } = setup();
    client.listUsers.mockResolvedValue({
      Resources: [{ id: 'scim-9', userName: 'ADM-ada@corp.example' }],
    });

    await service.setActive(config, { userNames: ['adm-ada@corp.example'] }, true);

    expect(client.listUsers.mock.calls[0][1]).toBe('userName eq "adm-ada@corp.example"');
    expect(client.patchUser).toHaveBeenCalledWith(config, 'scim-9', patchActive(true));
  });

  it('answers not-found for an unknown id or no match', async () => {
    const { client, service } = setup();
    client.patchUser.mockRejectedValue(new SCIMError(undefined, 'User not found', '404'));
    await expect(service.setActive(config, { id: 'gone' }, false)).resolves.toEqual({
      outcome: 'not-found',
      detail: 'no such user',
    });

    client.listUsers.mockResolvedValue({ Resources: [{ id: 'x', userName: 'someone@else' }] });
    await expect(
      service.setActive(config, { userNames: ['adm-ada@corp.example'] }, true),
    ).resolves.toEqual({ outcome: 'not-found', detail: 'no such user' });
  });
});

describe('Okta: a privileged session suspends and unsuspends', () => {
  const config: OktaConfig = { orgUrl: 'https://acme.okta.example/', apiToken: 'ssws-test' };

  function oktaUser(status: string | Error) {
    const posts: string[] = [];
    const instance = {
      get: jest.fn(async () => {
        if (status instanceof Error) throw status;
        return { status: 200, data: { id: '00u1', status, profile: {} }, headers: {} };
      }),
      post: jest.fn(async (url: string) => {
        posts.push(url);
        return { status: 200, data: {}, headers: {} };
      }),
    };
    (axios.create as jest.Mock).mockReturnValue(instance);
    const service = new OktaProvisioningService(new OktaClient(), new OktaMapper());
    return { posts, instance, service };
  }
  const user = { login: 'adm-ada@corp.example' };

  it('unsuspends a SUSPENDED user and suspends an ACTIVE one', async () => {
    const suspended = oktaUser('SUSPENDED');
    await expect(suspended.service.setUserEnabled(config, user, true)).resolves.toEqual({
      outcome: 'done',
      detail: 'unsuspended',
    });
    expect(suspended.instance.get).toHaveBeenCalledWith('/users/adm-ada%40corp.example');
    expect(suspended.posts).toEqual(['/users/00u1/lifecycle/unsuspend']);

    const active = oktaUser('ACTIVE');
    await expect(
      active.service.setUserEnabled(config, { ...user, oktaUserId: '00u1' }, false),
    ).resolves.toEqual({ outcome: 'done', detail: 'suspended' });
    expect(active.posts).toEqual(['/users/00u1/lifecycle/suspend']);
  });

  it('leaves a user as it is when it already is so', async () => {
    const active = oktaUser('ACTIVE');
    await expect(active.service.setUserEnabled(config, user, true)).resolves.toEqual({
      outcome: 'done',
      detail: 'already active',
    });
    const staged = oktaUser('STAGED');
    await expect(staged.service.setUserEnabled(config, user, false)).resolves.toEqual({
      outcome: 'done',
      detail: 'already staged',
    });
    expect([...active.posts, ...staged.posts]).toEqual([]);
  });

  // HX-B follow-up: a first session activates a STAGED admin account (PROVISIONED: its owner
  // still has to finish activation). Its end counted PROVISIONED as disabled, so pamTargetState
  // became `disabled`; the owner then finished activation and the account was ACTIVE outside any
  // session, and the hourly sweep skipped it. The disable now fails for a PROVISIONED user, so
  // the session records the target state `enabled` and the sweep tries again each hour until the
  // owner has activated it and it can be suspended.
  it('does not count a PROVISIONED user as disabled: Okta cannot suspend it yet', async () => {
    const provisioned = oktaUser('PROVISIONED');

    await expect(provisioned.service.setUserEnabled(config, user, false)).rejects.toThrow(
      /PROVISIONED.*hourly sweep suspends it once its owner has activated it/,
    );
    expect(provisioned.posts).toEqual([]);

    const activatedSince = oktaUser('ACTIVE');
    await expect(activatedSince.service.setUserEnabled(config, user, false)).resolves.toEqual({
      outcome: 'done',
      detail: 'suspended',
    });
  });

  // A linked admin account is created STAGED (it cannot sign in outside a session; from package
  // G's report, okta.client.ts:78), so its first session activates it: Okta makes it PROVISIONED
  // and emails its owner the activation link
  it('activates a STAGED user', async () => {
    const staged = oktaUser('STAGED');
    await expect(staged.service.setUserEnabled(config, user, true)).resolves.toEqual({
      outcome: 'done',
      detail: 'activated: its owner finishes the activation Okta emailed',
    });
    expect(staged.posts).toEqual(['/users/00u1/lifecycle/activate?sendEmail=true']);
  });

  it('refuses what Okta cannot do, for an admin to check', async () => {
    await expect(
      oktaUser('DEPROVISIONED').service.setUserEnabled(config, user, true),
    ).rejects.toThrow(/DEPROVISIONED.*cannot enable/);
    await expect(
      oktaUser('LOCKED_OUT').service.setUserEnabled(config, user, false),
    ).rejects.toThrow(/LOCKED_OUT.*suspends only an ACTIVE user/);
  });

  it('answers not-found for a user Okta does not know', async () => {
    const { service, posts } = oktaUser(httpError(404));
    await expect(service.setUserEnabled(config, user, false)).resolves.toEqual({
      outcome: 'not-found',
      detail: 'no such user',
    });
    expect(posts).toEqual([]);
  });
});
