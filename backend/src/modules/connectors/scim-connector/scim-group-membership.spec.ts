/**
 * SCIM group membership for access reviews and the mover, against a mocked SCIM client: the
 * user's `groups` attribute (absent vs. empty vs. no such user), the RFC 7644 PATCHes that add
 * and remove a member, and the lookup by userName / emails that ignores users not matching the
 * filter. Untested against a live SCIM service provider.
 */
import { SCIMService } from './scim.service';
import type { SCIMClient } from './scim.client';
import { SCIMMapper } from './scim.mapper';
import type { SCIMConnectorConfig } from './scim.interface';
import { SCIMError, SCIM_SCHEMAS } from '@shared/scim';

const config: SCIMConnectorConfig = { baseUrl: 'https://scim.acme.test/v2', authType: 'bearer' };

function setup() {
  const client = {
    getUser: jest.fn(),
    listUsers: jest.fn(),
    patchGroup: jest.fn().mockResolvedValue(undefined),
  };
  return { client, service: new SCIMService(client as unknown as SCIMClient, new SCIMMapper()) };
}

const list = (Resources: object[]) => ({
  schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
  totalResults: Resources.length,
  startIndex: 1,
  itemsPerPage: Resources.length,
  Resources,
});

describe('SCIMService.getUserGroups', () => {
  it("reads the user's groups attribute", async () => {
    const { service, client } = setup();
    client.getUser.mockResolvedValue({
      id: 'u1',
      userName: 'ada',
      groups: [{ value: 'g1', display: 'Engineering', type: 'direct' }, { display: 'no value' }],
    });
    await expect(service.getUserGroups(config, 'u1')).resolves.toEqual([
      { value: 'g1', display: 'Engineering', type: 'direct' },
    ]);
  });

  it('tells a missing attribute (undefined) from no such user (null)', async () => {
    const { service, client } = setup();
    client.getUser.mockResolvedValueOnce({ id: 'u1', userName: 'ada' });
    await expect(service.getUserGroups(config, 'u1')).resolves.toBeUndefined();
    client.getUser.mockRejectedValueOnce(new SCIMError(undefined, 'Resource not found', '404'));
    await expect(service.getUserGroups(config, 'u1')).resolves.toBeNull();
  });
});

describe('SCIMService.removeGroupMember', () => {
  it('PATCHes the group with remove members[value eq "<id>"]', async () => {
    const { service, client } = setup();
    await expect(service.removeGroupMember(config, 'g1', 'u"1')).resolves.toBe('removed');
    expect(client.patchGroup).toHaveBeenCalledWith(config, 'g1', {
      schemas: [SCIM_SCHEMAS.PATCH_OP],
      Operations: [{ op: 'remove', path: 'members[value eq "u\\"1"]' }],
    });
  });

  it.each([
    ['no such group (404)', new SCIMError(undefined, 'Group not found', '404')],
    ['no matching member (noTarget)', new SCIMError('noTarget', 'No member matched', '400')],
  ])('%s is not-member', async (_name, error) => {
    const { service, client } = setup();
    client.patchGroup.mockRejectedValue(error);
    await expect(service.removeGroupMember(config, 'g1', 'u1')).resolves.toBe('not-member');
  });

  it('propagates other errors (e.g. PATCH not supported)', async () => {
    const { service, client } = setup();
    client.patchGroup.mockRejectedValue(new SCIMError(undefined, 'Not implemented', '501'));
    await expect(service.removeGroupMember(config, 'g1', 'u1')).rejects.toThrow('Not implemented');
  });
});

describe('SCIMService.addGroupMember', () => {
  it('PATCHes the group with add members and the user id as value', async () => {
    const { service, client } = setup();
    await expect(service.addGroupMember(config, 'g1', 'u1')).resolves.toBe('added');
    expect(client.patchGroup).toHaveBeenCalledWith(config, 'g1', {
      schemas: [SCIM_SCHEMAS.PATCH_OP],
      Operations: [{ op: 'add', path: 'members', value: [{ value: 'u1' }] }],
    });
  });

  it('a 409 (the member is already there) is already-member', async () => {
    const { service, client } = setup();
    client.patchGroup.mockRejectedValue(new SCIMError('uniqueness', 'Already a member', '409'));
    await expect(service.addGroupMember(config, 'g1', 'u1')).resolves.toBe('already-member');
  });

  it('propagates a missing group (404) and other errors', async () => {
    const { service, client } = setup();
    client.patchGroup.mockRejectedValue(new SCIMError(undefined, 'Group not found', '404'));
    await expect(service.addGroupMember(config, 'g1', 'u1')).rejects.toThrow('Group not found');
  });
});

describe('SCIMService.findUserIdByIdentifiers', () => {
  it('tries userNames, then emails, and ignores a user that does not carry the value', async () => {
    const { service, client } = setup();
    client.listUsers
      .mockResolvedValueOnce(list([{ id: 'other', userName: 'someone-else' }])) // filter ignored
      .mockResolvedValueOnce(list([]))
      .mockResolvedValueOnce(
        list([{ id: 'u1', userName: 'x', emails: [{ value: 'Ada@Acme.test' }] }]),
      );

    await expect(
      service.findUserIdByIdentifiers(config, {
        userNames: ['ada@corp.test', 'ada@acme.test'],
        emails: ['ada@acme.test'],
      }),
    ).resolves.toBe('u1');
    expect(client.listUsers.mock.calls.map((c) => c[1])).toEqual([
      'userName eq "ada@corp.test"',
      'userName eq "ada@acme.test"',
      'emails.value eq "ada@acme.test"',
    ]);
  });

  it('is null when nothing matches', async () => {
    const { service, client } = setup();
    client.listUsers.mockResolvedValue(list([]));
    await expect(
      service.findUserIdByIdentifiers(config, { emails: ['ada@acme.test'] }),
    ).resolves.toBeNull();
  });
});
