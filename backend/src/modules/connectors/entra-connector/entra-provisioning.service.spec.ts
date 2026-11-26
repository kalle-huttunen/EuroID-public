/**
 * captureUserState / restoreUserState: the snapshot a bulk rollback uses to put an Entra account
 * back. It must read exactly the attributes provision() would write, on the account provision()
 * would update.
 */
import { NotFoundException } from '@nestjs/common';
import { EntraProvisioningService } from './entra-provisioning.service';
import { AmbiguousAccountException, EntraDiscoveryService } from './entra-discovery.service';
import { EntraMapper } from './entra.mapper';
import { createMockUser } from '@testing/mock-factories';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';

type Ctor = ConstructorParameters<typeof EntraProvisioningService>;

describe('EntraProvisioningService snapshot for compensation', () => {
  let client: { get: jest.Mock; patch: jest.Mock };
  let discovery: { checkUserExists: jest.Mock };
  let service: EntraProvisioningService;

  beforeEach(() => {
    client = { get: jest.fn(), patch: jest.fn() };
    discovery = { checkUserExists: jest.fn() };
    service = new EntraProvisioningService(
      client as unknown as Ctor[0],
      new EntraMapper(),
      {
        get: jest.fn((key: string) => (key === 'ENTRA_DEFAULT_DOMAIN' ? 'corp.test' : undefined)),
      } as unknown as Ctor[2],
      discovery as unknown as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
    );
  });

  const user = createMockUser({
    email: 'ada@corp.test',
    userPrincipalName: 'ada@corp.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    jobTitle: 'Engineer',
  });

  it('reads the attributes the update would write on the account provision() would update', async () => {
    discovery.checkUserExists.mockResolvedValue('obj-1');
    client.get.mockResolvedValue({ id: 'obj-1', givenName: 'Ada', jobTitle: 'Analyst' });
    const fields = Object.keys(new EntraMapper().toEntraUpdatePayload(user));

    const state = await service.captureUserState(user);

    expect(discovery.checkUserExists).toHaveBeenCalledWith('ada@corp.test', undefined);
    expect(client.get).toHaveBeenCalledWith(`/users/obj-1?$select=${fields.join(',')}`, undefined);
    expect(state.existed).toBe(true);
    expect(state.objectId).toBe('obj-1');
    expect(Object.keys(state.attributes ?? {})).toEqual(fields);
    expect(state.attributes).toMatchObject({
      givenName: 'Ada',
      jobTitle: 'Analyst',
      surname: null,
    });
  });

  it('reports no account when provision() would create one', async () => {
    discovery.checkUserExists.mockResolvedValue(null);

    await expect(service.captureUserState(user)).resolves.toEqual({ existed: false });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('writes the captured values back, nulls included', async () => {
    await service.restoreUserState('obj-1', { jobTitle: 'Analyst', city: null });

    expect(client.patch).toHaveBeenCalledWith(
      '/users/obj-1',
      { jobTitle: 'Analyst', city: null },
      undefined,
    );
  });
});

/**
 * provision() for an identity with a written-back object id: the account is that one. A UPN that
 * no longer matches (renamed in Entra ID) must not make it create a second account.
 */
describe('EntraProvisioningService.provision with the recorded object id', () => {
  let client: { get: jest.Mock; patch: jest.Mock; post: jest.Mock };
  let discovery: { checkUserExists: jest.Mock };
  let service: EntraProvisioningService;
  const user = createMockUser({
    email: 'ada@corp.test',
    userPrincipalName: 'ada@corp.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
  });

  beforeEach(() => {
    client = { get: jest.fn(), patch: jest.fn(), post: jest.fn() };
    // The UPN no longer names an account; only the recorded id does
    discovery = {
      checkUserExists: jest.fn(async (id: string) => (id === 'obj-1' ? 'obj-1' : null)),
    };
    service = new EntraProvisioningService(
      client as unknown as Ctor[0],
      new EntraMapper(),
      {
        get: jest.fn((key: string) => (key === 'ENTRA_DEFAULT_DOMAIN' ? 'corp.test' : undefined)),
      } as unknown as Ctor[2],
      discovery as unknown as Ctor[3],
      {} as Ctor[4],
      { generatePassword: () => 'Generated-Passw0rd!' } as unknown as Ctor[5],
    );
  });

  it('updates the account with that id, found by the id alone', async () => {
    const result = await service.provision(user, undefined, undefined, 'obj-1');

    expect(discovery.checkUserExists).toHaveBeenCalledTimes(1);
    expect(discovery.checkUserExists).toHaveBeenCalledWith('obj-1', undefined);
    expect(client.patch).toHaveBeenCalledWith('/users/obj-1', expect.any(Object), undefined);
    expect(client.post).not.toHaveBeenCalled();
    expect(result).toEqual({ targetUserId: 'obj-1', generatedAttributes: undefined });
  });

  it('fails (422) when Entra ID no longer has that account, and creates none', async () => {
    const error = await service
      .provision(user, undefined, undefined, 'obj-gone')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectorException);
    expect((error as ConnectorException).getStatus()).toBe(422);
    expect((error as Error).message).toContain(
      'No Entra ID account has the object id recorded for the identity (obj-gone)',
    );
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });
});

/**
 * provision() with mustExist (the mover, an edit's sync to Entra ID) for an identity whose account
 * has no recorded object id (bulk provisioning writes none back): the account is found by the
 * identifiers the profile holds, or the call fails. It never creates a second account.
 * FOLLOWUPS 2026-11-24, entra-provisioning.service.ts. Real discovery service, Graph faked.
 */
describe('EntraProvisioningService.provision with mustExist', () => {
  type Account = { id: string; userPrincipalName: string; mail?: string; employeeId?: string };
  let client: { get: jest.Mock; patch: jest.Mock; post: jest.Mock };
  // The profile's UPN and email no longer name the account (renamed in Entra ID)
  const user = createMockUser({
    email: 'ada@corp.test',
    userPrincipalName: 'ada@corp.test',
    employeeId: 'EMP-001',
  });

  /** Graph's answers for these accounts: GET /users/{id or UPN}, and the $filter lookups. */
  function graph(accounts: Account[]) {
    return jest.fn(async (path: string) => {
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
        const matches = accounts.filter((a) => a.employeeId === byEmployeeId[1]);
        return { value: matches.map((a) => ({ id: a.id })) };
      }
      throw new Error(`unexpected Graph call: ${path}`);
    });
  }

  function serviceWith(accounts: Account[]) {
    client = { get: graph(accounts), patch: jest.fn(), post: jest.fn() };
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

  it('finds the account by its employee id and updates it', async () => {
    const service = serviceWith([
      { id: 'obj-5', userPrincipalName: 'a.lovelace@corp.test', employeeId: 'EMP-001' },
    ]);

    const result = await service.provision(user, undefined, undefined, undefined, true);

    expect(result.targetUserId).toBe('obj-5');
    expect(client.patch).toHaveBeenCalledWith('/users/obj-5', expect.any(Object), undefined);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('finds the account by the email as its mail', async () => {
    const service = serviceWith([
      { id: 'obj-6', userPrincipalName: 'a.lovelace@corp.test', mail: 'ada@corp.test' },
    ]);

    await expect(
      service.provision(user, undefined, undefined, undefined, true),
    ).resolves.toMatchObject({ targetUserId: 'obj-6' });
    expect(client.post).not.toHaveBeenCalled();
  });

  it('fails (422) and creates none when no account has the identifiers', async () => {
    const service = serviceWith([
      { id: 'obj-9', userPrincipalName: 'someone@corp.test', employeeId: 'EMP-999' },
    ]);

    const error = await service
      .provision(user, undefined, undefined, undefined, true)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConnectorException);
    expect((error as ConnectorException).getStatus()).toBe(422);
    expect((error as Error).message).toContain(
      'The Entra ID account of this identity was not found',
    );
    expect((error as Error).message).toContain('Link the account to the identity or re-provision');
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it('fails (422) when two accounts carry the employee id, choosing neither', async () => {
    const service = serviceWith([
      { id: 'obj-5', userPrincipalName: 'a.lovelace@corp.test', employeeId: 'EMP-001' },
      { id: 'obj-7', userPrincipalName: 'ada.l@corp.test', employeeId: 'EMP-001' },
    ]);

    const error = await service
      .provision(user, undefined, undefined, undefined, true)
      .catch((e: unknown) => e);

    expect((error as ConnectorException).getStatus()).toBe(422);
    expect((error as Error).message).toContain(
      'More than one Entra ID account has the employee id',
    );
    expect(error).toBeInstanceOf(AmbiguousAccountException);
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  // HX-E3: the lookup takes an account only when it is the one match. Before, the email step
  // asked Graph for one ($top=1) and took whichever account came first.
  it('fails (422) when two accounts have the email as mail or UPN, choosing neither', async () => {
    const service = serviceWith([
      { id: 'obj-6', userPrincipalName: 'a.lovelace@corp.test', mail: 'ada@corp.test' },
      { id: 'obj-8', userPrincipalName: 'ada.l@corp.test', mail: 'ada@corp.test' },
    ]);

    const error = await service
      .provision(user, undefined, undefined, undefined, true)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AmbiguousAccountException);
    expect((error as ConnectorException).getStatus()).toBe(422);
    expect((error as Error).message).toContain('More than one Entra ID account has the email');
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });
});

/**
 * A linked admin account (PAM) keeps the UPN admin-upn.ts gave it (adm-<first>.<last>@...).
 * From package G's report (2026-11-25): when that UPN was outside the Entra ID default domain or
 * already taken, resolveAvailableUpn fell back to firstname.lastname candidates, so the admin
 * account could get a regular-looking UPN. It now gets its admin UPN or fails with the reason.
 */
describe('EntraProvisioningService.resolveAvailableUpn for a linked admin account', () => {
  let discovery: { checkUserExists: jest.Mock; isDefaultDomainVerified: jest.Mock };
  let service: EntraProvisioningService;

  beforeEach(() => {
    discovery = {
      checkUserExists: jest.fn().mockResolvedValue(null),
      isDefaultDomainVerified: jest.fn().mockResolvedValue({ ok: true, verifiedDomains: [] }),
    };
    service = new EntraProvisioningService(
      {} as Ctor[0],
      new EntraMapper(),
      {
        get: jest.fn((key: string) => (key === 'ENTRA_DEFAULT_DOMAIN' ? 'corp.test' : undefined)),
      } as unknown as Ctor[2],
      discovery as unknown as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
    );
  });

  const admin = (userPrincipalName: string) =>
    createMockUser({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: userPrincipalName,
      userPrincipalName,
      employmentType: 'ADMIN_ACCOUNT' as never,
      sourceSystem: 'euroid-pam',
    });

  it('chooses the admin UPN when it is free in the default domain', async () => {
    await expect(service.resolveAvailableUpn(admin('adm-ada.lovelace@corp.test'))).resolves.toEqual(
      {
        chosenUpn: 'adm-ada.lovelace@corp.test',
        candidatesChecked: ['adm-ada.lovelace@corp.test'],
      },
    );
  });

  it('fails, choosing no firstname.lastname UPN, when the admin UPN is outside the default domain', async () => {
    await expect(
      service.resolveAvailableUpn(admin('adm-ada.lovelace@admin.corp.test')),
    ).rejects.toThrow(/admin account.*default domain/i);
    expect(discovery.checkUserExists).not.toHaveBeenCalled();
  });

  it('fails, choosing no other UPN, when another account holds the admin UPN', async () => {
    discovery.checkUserExists.mockResolvedValue('obj-other');

    await expect(service.resolveAvailableUpn(admin('adm-ada.lovelace@corp.test'))).rejects.toThrow(
      /admin account.*taken/i,
    );
    expect(discovery.checkUserExists).toHaveBeenCalledTimes(1);
  });

  it('still falls back to firstname.lastname candidates for a regular user', async () => {
    const regular = createMockUser({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@elsewhere.test',
      userPrincipalName: undefined,
    });

    await expect(service.resolveAvailableUpn(regular)).resolves.toMatchObject({
      chosenUpn: 'ada.lovelace@corp.test',
    });
  });
});
