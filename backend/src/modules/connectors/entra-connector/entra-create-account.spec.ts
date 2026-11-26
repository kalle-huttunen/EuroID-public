/**
 * createAccount: the create-only path of a distributed-transaction CREATE (HX-F2 follow-up).
 * provision() takes over an account that already has the user's UPN or email and updates it; the
 * transaction then reported that account as created, and its rollback deleted a pre-existing
 * account. createAccount creates under the UPN prepare resolved, or fails with a conflict when
 * any account is in the way, and never writes to an existing account.
 */
import { HttpStatus, NotFoundException } from '@nestjs/common';
import { EntraProvisioningService } from './entra-provisioning.service';
import { AmbiguousAccountException, EntraDiscoveryService } from './entra-discovery.service';
import { EntraMapper } from './entra.mapper';
import { createMockUser } from '@testing/mock-factories';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';

type Ctor = ConstructorParameters<typeof EntraProvisioningService>;
type Account = { id: string; userPrincipalName: string; mail?: string; employeeId?: string };

describe('EntraProvisioningService.createAccount (create only, never take over)', () => {
  let client: { get: jest.Mock; patch: jest.Mock; post: jest.Mock };
  const user = createMockUser({
    email: 'ada@corp.test',
    userPrincipalName: undefined,
    firstName: 'Ada',
    lastName: 'Lovelace',
    employeeId: 'EMP-001',
  });
  const UPN = 'ada.lovelace@corp.test';

  /** Graph's answers for these accounts: GET /users/{id or UPN}, and the $filter lookups. */
  function serviceWith(accounts: Account[]) {
    const get = jest.fn(async (path: string) => {
      const byKey = /^\/users\/([^?]+)\?\$select=id$/.exec(path);
      if (byKey) {
        const key = decodeURIComponent(byKey[1]!);
        const account = accounts.find((a) => a.id === key || a.userPrincipalName === key);
        if (!account) throw new NotFoundException();
        return { id: account.id };
      }
      const filter = decodeURIComponent(/\$filter=([^&]+)/.exec(path)?.[1] ?? '');
      const byMail = /^mail eq '(.*)' or userPrincipalName eq '(.*)'$/.exec(filter);
      if (byMail) {
        return {
          value: accounts.filter((a) => a.mail === byMail[1] || a.userPrincipalName === byMail[2]),
        };
      }
      const byEmployeeId = /^employeeId eq '(.*)'$/.exec(filter);
      if (byEmployeeId) {
        return { value: accounts.filter((a) => a.employeeId === byEmployeeId[1]) };
      }
      throw new Error(`unexpected Graph call: ${path}`);
    });
    client = {
      get,
      patch: jest.fn(),
      post: jest.fn(async (_path: string, body: Record<string, unknown>) => ({
        id: 'obj-new',
        userPrincipalName: body.userPrincipalName,
      })),
    };
    const config = {
      get: jest.fn((key: string) => (key === 'ENTRA_DEFAULT_DOMAIN' ? 'corp.test' : undefined)),
    } as unknown as Ctor[2];
    return new EntraProvisioningService(
      client as unknown as Ctor[0],
      new EntraMapper(),
      config,
      new EntraDiscoveryService(client as unknown as Ctor[0], config),
      {} as Ctor[4],
      { generatePassword: () => 'Generated-Passw0rd!' } as unknown as Ctor[5],
    );
  }

  it('creates the account under the UPN it is given and reports it as created', async () => {
    const service = serviceWith([]);

    const result = await service.createAccount(user, UPN);

    expect(client.post).toHaveBeenCalledWith(
      '/users',
      expect.objectContaining({ userPrincipalName: UPN }),
      undefined,
    );
    expect(result).toMatchObject({
      targetUserId: 'obj-new',
      upnResolution: { chosenUpn: UPN, candidatesChecked: [UPN] },
    });
  });

  it.each<[string, Account]>([
    ['the UPN', { id: 'obj-upn', userPrincipalName: UPN }],
    ['the email as UPN', { id: 'obj-email-upn', userPrincipalName: 'ada@corp.test' }],
    [
      'the email as mail',
      { id: 'obj-mail', userPrincipalName: 'a.l@corp.test', mail: 'ada@corp.test' },
    ],
    ['the employee id', { id: 'obj-emp', userPrincipalName: 'x@corp.test', employeeId: 'EMP-001' }],
  ])('fails with a conflict when an account has %s, and changes no account', async (_, account) => {
    const service = serviceWith([account]);

    const failure = await service.createAccount(user, UPN).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ConnectorException);
    expect((failure as ConnectorException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("fails when an account has the user's own UPN, also when it is not the one resolved", async () => {
    const service = serviceWith([{ id: 'obj-own', userPrincipalName: 'ada.l@corp.test' }]);

    await expect(
      service.createAccount({ ...user, userPrincipalName: 'ada.l@corp.test' }, UPN),
    ).rejects.toBeInstanceOf(ConnectorException);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('fails, creating nothing, when two accounts carry the email', async () => {
    const service = serviceWith([
      { id: 'obj-1', userPrincipalName: 'a1@corp.test', mail: 'ada@corp.test' },
      { id: 'obj-2', userPrincipalName: 'a2@corp.test', mail: 'ada@corp.test' },
    ]);

    await expect(service.createAccount(user, UPN)).rejects.toBeInstanceOf(
      AmbiguousAccountException,
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it('existingAccountFor names the account in the way, and null when there is none', async () => {
    await expect(serviceWith([]).existingAccountFor(user, UPN)).resolves.toBeNull();
    await expect(
      serviceWith([
        { id: 'obj-emp', userPrincipalName: 'x@corp.test', employeeId: 'EMP-001' },
      ]).existingAccountFor(user, UPN),
    ).resolves.toBe('obj-emp');
  });
});

/** The lookup a retried distributed-transaction CREATE uses to find the account it made. */
describe('EntraDiscoveryService.findAccountByUpn', () => {
  const discoveryWith = (get: jest.Mock) =>
    new EntraDiscoveryService(
      { get } as unknown as ConstructorParameters<typeof EntraDiscoveryService>[0],
      { get: jest.fn() } as unknown as ConstructorParameters<typeof EntraDiscoveryService>[1],
    );

  it('answers the account with that UPN and when Entra ID created it', async () => {
    const get = jest
      .fn()
      .mockResolvedValue({ id: 'obj-1', createdDateTime: '2026-11-26T08:00:03Z' });

    await expect(discoveryWith(get).findAccountByUpn('ada.l2@corp.test')).resolves.toEqual({
      id: 'obj-1',
      createdDateTime: '2026-11-26T08:00:03Z',
    });
    expect(get).toHaveBeenCalledWith(
      '/users/ada.l2%40corp.test?$select=id,createdDateTime',
      undefined,
    );
  });

  it('answers null when no account has the UPN', async () => {
    const get = jest.fn().mockRejectedValue(new NotFoundException());

    await expect(discoveryWith(get).findAccountByUpn('ada.l2@corp.test')).resolves.toBeNull();
  });
});
