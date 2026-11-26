/**
 * SCIM inbound groups: an IdP keeps a group's members in EuroID with PATCH (add, remove by value
 * or by a `members[value eq "..."]` path, replace) and PUT. Each change is stored on the SCIM
 * group's catalog entry and announced as entitlement.updated with the members it now has. An
 * unknown id is 404 and a malformed body 400, in SCIM's error model, and nothing is written.
 * The catalog service and the event emitter are mocked.
 *
 * Each member keeps the type the IdP sent it with: a group nested in another is stored and
 * returned as a Group with a Groups $ref. Every member was stored as a bare value and returned as
 * a User (FOLLOWUPS 2026-11-25, scim-inbound.mapper.ts:227). A member without a type stays a User.
 */
import { Test } from '@nestjs/testing';
import { ScimGroupsController } from './scim-groups.controller';
import { ScimInboundMapper } from './scim-inbound.mapper';
import { ScimFilterService } from './scim-filter.service';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { SCIM_SCHEMAS, SCIMError } from '@shared/scim';

const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} } as never;

const patchOf = (...Operations: Array<{ op: string; path?: string; value?: unknown }>) => ({
  schemas: [SCIM_SCHEMAS.PATCH_OP],
  Operations,
});

describe('ScimGroupsController', () => {
  let controller: ScimGroupsController;
  let catalog: {
    findById: jest.Mock;
    updateScimGroup: jest.Mock;
    deleteScimGroup: jest.Mock;
    createScimGroup: jest.Mock;
    listScimGroups: jest.Mock;
  };
  let emit: jest.Mock;

  beforeEach(async () => {
    catalog = {
      findById: jest.fn().mockResolvedValue({
        _id: 'g1',
        name: 'Engineers',
        system: 'scim-inbound',
        metadata: { scimMembers: ['u1', 'u2'] },
      }),
      updateScimGroup: jest.fn(
        async (
          id: string,
          updates: { name?: string; scimMembers?: string[]; scimMemberTypes?: unknown[] },
        ) => ({
          _id: id,
          name: updates.name ?? 'Engineers',
          metadata: { scimMembers: updates.scimMembers, scimMemberTypes: updates.scimMemberTypes },
        }),
      ),
      deleteScimGroup: jest.fn().mockResolvedValue(true),
      createScimGroup: jest.fn(),
      listScimGroups: jest.fn(),
    };
    emit = jest.fn();

    const module = await Test.createTestingModule({
      controllers: [ScimGroupsController],
      providers: [
        ScimInboundMapper,
        ScimFilterService,
        { provide: EntitlementCatalogService, useValue: catalog },
        { provide: DomainEventEmitterService, useValue: { emit } },
      ],
    })
      .overrideGuard(ScimAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(ScimGroupsController);
  });

  describe('PATCH members', () => {
    it.each([
      [
        'adds members, each once',
        patchOf({ op: 'add', path: 'members', value: [{ value: 'u3' }, { value: 'u1' }] }),
        ['u1', 'u2', 'u3'],
      ],
      [
        'removes members by value',
        patchOf({ op: 'remove', path: 'members', value: [{ value: 'u1' }] }),
        ['u2'],
      ],
      [
        'removes a member by a members[value eq] path',
        patchOf({ op: 'remove', path: 'members[value eq "u2"]' }),
        ['u1'],
      ],
      [
        'replaces the members',
        patchOf({ op: 'replace', path: 'members', value: [{ value: 'u9' }] }),
        ['u9'],
      ],
    ])('%s, stores them and announces the group', async (_label, body, members) => {
      const group = await controller.patch('g1', body, req);

      expect(catalog.updateScimGroup).toHaveBeenCalledWith('g1', {
        scimMembers: members,
        scimMemberTypes: [],
      });
      expect(emit).toHaveBeenCalledWith(DomainEventType.ENTITLEMENT_UPDATED, 'g1', {
        groupId: 'g1',
        members,
        system: 'scim-inbound',
      });
      expect(group.members?.map((m) => m.value)).toEqual(members);
    });

    it('renames the group with a displayName replace, keeping its members', async () => {
      await controller.patch(
        'g1',
        patchOf({ op: 'replace', path: 'displayName', value: 'Eng' }),
        req,
      );

      expect(catalog.updateScimGroup).toHaveBeenCalledWith('g1', {
        name: 'Eng',
        scimMembers: ['u1', 'u2'],
        scimMemberTypes: [],
      });
    });
  });

  describe('member types', () => {
    const BASE = 'http://localhost:3001/scim/v2';
    const typesOf = (group: { members?: Array<{ value: string; type?: string; $ref?: string }> }) =>
      group.members?.map((m) => [m.value, m.type, m.$ref]);

    it('PATCH add keeps each member type, a group as a Group with its Groups $ref', async () => {
      const group = await controller.patch(
        'g1',
        patchOf({
          op: 'add',
          path: 'members',
          value: [{ value: 'g7', type: 'Group' }, { value: 'u3', type: 'User' }, { value: 'u4' }],
        }),
        req,
      );

      expect(catalog.updateScimGroup).toHaveBeenCalledWith('g1', {
        scimMembers: ['u1', 'u2', 'g7', 'u3', 'u4'],
        scimMemberTypes: [
          { value: 'g7', type: 'Group' },
          { value: 'u3', type: 'User' },
        ],
      });
      expect(typesOf(group)).toEqual([
        ['u1', 'User', `${BASE}/Users/u1`],
        ['u2', 'User', `${BASE}/Users/u2`],
        ['g7', 'Group', `${BASE}/Groups/g7`],
        ['u3', 'User', `${BASE}/Users/u3`],
        // No type: a user, as before types were kept
        ['u4', 'User', `${BASE}/Users/u4`],
      ]);
      // entitlement.updated still names the members by value
      expect(emit).toHaveBeenCalledWith(DomainEventType.ENTITLEMENT_UPDATED, 'g1', {
        groupId: 'g1',
        members: ['u1', 'u2', 'g7', 'u3', 'u4'],
        system: 'scim-inbound',
      });
    });

    it('PATCH remove drops a removed group member with its type', async () => {
      catalog.findById.mockResolvedValue({
        _id: 'g1',
        name: 'Engineers',
        system: 'scim-inbound',
        metadata: { scimMembers: ['u1', 'g7'], scimMemberTypes: [{ value: 'g7', type: 'Group' }] },
      });

      await controller.patch('g1', patchOf({ op: 'remove', path: 'members[value eq "g7"]' }), req);

      expect(catalog.updateScimGroup).toHaveBeenCalledWith('g1', {
        scimMembers: ['u1'],
        scimMemberTypes: [],
      });
    });

    it('PUT stores and returns the members with their types', async () => {
      const group = await controller.replace(
        'g1',
        {
          schemas: [SCIM_SCHEMAS.GROUP],
          displayName: 'Engineers',
          members: [
            { value: 'g8', type: 'group' },
            { value: 'u5', type: 'User' },
          ],
        },
        req,
      );

      expect(catalog.updateScimGroup).toHaveBeenCalledWith('g1', {
        name: 'Engineers',
        externalId: undefined,
        scimMembers: ['g8', 'u5'],
        scimMemberTypes: [
          { value: 'g8', type: 'Group' },
          { value: 'u5', type: 'User' },
        ],
      });
      expect(typesOf(group)).toEqual([
        ['g8', 'Group', `${BASE}/Groups/g8`],
        ['u5', 'User', `${BASE}/Users/u5`],
      ]);
    });

    it('GET returns a stored group member as a Group, the others as users', async () => {
      catalog.findById.mockResolvedValue({
        _id: 'g1',
        name: 'Engineers',
        system: 'scim-inbound',
        metadata: { scimMembers: ['u1', 'g7'], scimMemberTypes: [{ value: 'g7', type: 'Group' }] },
      });

      const group = await controller.getById('g1', req);

      expect(typesOf(group)).toEqual([
        ['u1', 'User', `${BASE}/Users/u1`],
        ['g7', 'Group', `${BASE}/Groups/g7`],
      ]);
    });
  });

  it.each([
    [
      'PATCH',
      () =>
        controller.patch('unknown', patchOf({ op: 'add', path: 'members', value: ['u3'] }), req),
    ],
    [
      'PUT',
      () =>
        controller.replace('unknown', { schemas: [SCIM_SCHEMAS.GROUP], displayName: 'Eng' }, req),
    ],
    ['DELETE', () => controller.delete('unknown')],
  ])('%s answers 404 for a group it does not hold, writing nothing', async (_m, call) => {
    catalog.findById.mockResolvedValue(null);

    await expect(call()).rejects.toMatchObject({ scimStatus: '404', detail: 'Group not found' });
    expect(catalog.updateScimGroup).not.toHaveBeenCalled();
    expect(catalog.deleteScimGroup).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    [
      'PATCH without operations',
      () => controller.patch('g1', { schemas: [SCIM_SCHEMAS.PATCH_OP] }, req),
    ],
    [
      'PUT without a displayName',
      () => controller.replace('g1', { schemas: [SCIM_SCHEMAS.GROUP] }, req),
    ],
  ])('%s answers 400 invalidValue, reading and writing nothing', async (_m, call) => {
    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SCIMError);
    expect(error).toMatchObject({
      scimType: 'invalidValue',
      scimStatus: '400',
      detail: expect.stringMatching(/^Validation failed: /),
    });
    expect(catalog.findById).not.toHaveBeenCalled();
    expect(catalog.updateScimGroup).not.toHaveBeenCalled();
  });
});
