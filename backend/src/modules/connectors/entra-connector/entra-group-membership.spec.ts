/**
 * Entra ID membership reads and removal for access reviews, against a mocked Graph client:
 * every page of memberOf with each membership's kind, and a removal that tells "removed" from
 * Graph's 404 (no such membership). Untested against a live tenant.
 */
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { EntraEntitlementsService } from './entra-entitlements.service';
import type { EntraClient } from './entra.client';

function setup() {
  const client = {
    get: jest.fn(),
    getByUrl: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const service = new EntraEntitlementsService(
    client as unknown as EntraClient,
    { get: jest.fn() } as unknown as ConfigService,
  );
  return { service, client };
}

describe('EntraEntitlementsService.listUserMemberships', () => {
  it('reads every page and keeps each membership kind', async () => {
    const { service, client } = setup();
    const next = 'https://graph.microsoft.com/v1.0/users/obj-1/memberOf?$skiptoken=abc';
    client.get.mockResolvedValue({
      value: [{ id: 'g-1', displayName: 'Finance', '@odata.type': '#microsoft.graph.group' }],
      '@odata.nextLink': next,
    });
    client.getByUrl.mockResolvedValue({
      value: [
        { id: 'r-1', displayName: 'Helpdesk', '@odata.type': '#microsoft.graph.directoryRole' },
      ],
    });

    await expect(service.listUserMemberships('obj-1')).resolves.toEqual([
      { id: 'g-1', displayName: 'Finance', odataType: '#microsoft.graph.group' },
      { id: 'r-1', displayName: 'Helpdesk', odataType: '#microsoft.graph.directoryRole' },
    ]);
    expect(client.get).toHaveBeenCalledWith(
      '/users/obj-1/memberOf?$select=id,displayName',
      undefined,
    );
    expect(client.getByUrl).toHaveBeenCalledWith(next, undefined);
  });

  it('a user Graph does not know has no memberships', async () => {
    const { service, client } = setup();
    client.get.mockRejectedValue(new NotFoundException());
    await expect(service.listUserMemberships('obj-1')).resolves.toEqual([]);
  });
});

describe('EntraEntitlementsService.removeGroupMember', () => {
  it('removes the membership reference', async () => {
    const { service, client } = setup();
    await expect(service.removeGroupMember('obj-1', 'g-1')).resolves.toBe('removed');
    expect(client.delete).toHaveBeenCalledWith('/groups/g-1/members/obj-1/$ref', undefined);
  });

  it("says not-member on Graph's 404 instead of claiming a removal", async () => {
    const { service, client } = setup();
    client.delete.mockRejectedValue(new NotFoundException());
    await expect(service.removeGroupMember('obj-1', 'g-1')).resolves.toBe('not-member');
  });

  it('propagates other errors', async () => {
    const { service, client } = setup();
    client.delete.mockRejectedValue(new Error('Entra API Error: Authorization_RequestDenied'));
    await expect(service.removeGroupMember('obj-1', 'g-1')).rejects.toThrow('Authorization');
  });
});

// Hunt 2026-11-25 (r2-01 N12): display names are not unique in Entra ID, and resolveGroupId took
// the first group of the name, so an intent naming a group could add the user to another group
// of the same name. Two or more matches now fail the operation.
describe('EntraEntitlementsService.resolveGroupId', () => {
  it('refuses a display name two groups share', async () => {
    const { service, client } = setup();
    client.get.mockResolvedValue({ value: [{ id: 'g-1' }, { id: 'g-2' }] });

    await expect(service.resolveGroupId('Finance')).rejects.toThrow(/more than one.*object id/i);
  });

  it('answers the one group that has the name', async () => {
    const { service, client } = setup();
    client.get.mockResolvedValue({ value: [{ id: 'g-1' }] });

    await expect(service.resolveGroupId('Finance')).resolves.toBe('g-1');
  });

  it('reports the ambiguous name as a failed operation of the intent, not a change', async () => {
    const { service, client } = setup();
    client.get.mockResolvedValue({ value: [{ id: 'g-1' }, { id: 'g-2' }] });
    const post = jest.fn();
    (client as unknown as { post: jest.Mock }).post = post;

    const [result] = await service.syncGroupMemberships('obj-1', [
      { action: 'add', type: 'group', targetId: 'Finance' },
    ] as never);

    expect(result).toMatchObject({ outcome: 'failed' });
    expect(post).not.toHaveBeenCalled();
  });
});
