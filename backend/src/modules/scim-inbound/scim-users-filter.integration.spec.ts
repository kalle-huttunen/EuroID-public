/**
 * GET /scim/v2/Users?filter=... against real identities (in-memory MongoDB, the real query
 * service, SCIM controller, mapper and filter service).
 *
 * Hunt 2026-11-25 (02 F1): the filter named the top-level fields `email`, `status` and
 * `displayName`, which an identity keeps under `profile.`, so `userName eq` never found the user
 * the IdP was about to create (its POST then answered 409, and provisioning stalled), `co` and
 * `sw` found nothing and `ne` found everyone. A filter now matches the attribute the SCIM
 * response shows: userName is the UPN, else the email; emails.value the email; active is ACTIVE
 * or PENDING. userName, emails.value and displayName compare without case (RFC 7643 section
 * 4.1.1, caseExact false).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import type { Request } from 'express';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { SCIMError, SCIM_SCHEMAS } from '@shared/scim';
import { createMockLoggerFactory, closeTestDb, testDbUri } from '@testing';
import { Identity, IdentitySchema, IdentityDocument } from '../identity/schemas/identity.schema';
import { IdentityQueryService } from '../identity/identity-query.service';
import type { IdentityService } from '../identity/identity.service';
import { ScimUsersController } from './scim-users.controller';
import { ScimInboundMapper } from './scim-inbound.mapper';
import { ScimFilterService } from './scim-filter.service';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-scim';
const req = { get: () => 'euroid.test', protocol: 'https', headers: {} } as unknown as Request;

describe('SCIM Users list filter (MongoDB)', () => {
  let moduleRef: TestingModule;
  let identities: Model<IdentityDocument>;
  let scim: ScimUsersController;
  const create = jest.fn(async (dto: Record<string, unknown>) => ({ _id: 'new-id', profile: dto }));

  beforeAll(async () => {
    const { factory } = createMockLoggerFactory();
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [IdentityQueryService, { provide: LoggerFactoryService, useValue: factory }],
    }).compile();
    const query = moduleRef.get(IdentityQueryService);
    identities = moduleRef.get(getModelToken(Identity.name));
    scim = new ScimUsersController(
      {
        findAllPaginated: (...args: Parameters<IdentityQueryService['findAllPaginated']>) =>
          query.findAllPaginated(...args),
        create,
      } as unknown as IdentityService,
      new ScimInboundMapper(),
      new ScimFilterService(),
    );
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await identities.deleteMany({}).setOptions({ skipTenantScope: true });
    const profile = (p: Record<string, unknown>) => ({
      tenantId: TENANT,
      profile: { firstName: 'X', lastName: 'Y', ...p },
    });
    await identities.create([
      profile({
        email: 'ada.lovelace@acme.test',
        userPrincipalName: 'Ada.Lovelace@acme.test',
        displayName: 'Ada Lovelace',
        status: UserStatus.ACTIVE,
      }),
      profile({ email: 'grace.hopper@acme.test', displayName: 'Grace Hopper', status: 'PENDING' }),
      profile({ email: 'alan.turing@acme.test', displayName: 'Alan Turing', status: 'INACTIVE' }),
      {
        tenantId: 'other-tenant',
        profile: { firstName: 'A', lastName: 'B', email: 'ada.lovelace@acme.test' },
      },
    ]);
  });

  const list = (filter: string) =>
    withTenantContext(TENANT, () => scim.list(req, undefined, undefined, filter));
  const userNames = async (filter: string) =>
    (await list(filter)).Resources.map((u) => u.userName).sort();

  it('finds the user by the userName the SCIM response shows, the UPN, in any case', async () => {
    await expect(userNames('userName eq "ada.lovelace@acme.test"')).resolves.toEqual([
      'Ada.Lovelace@acme.test',
    ]);
  });

  it('finds a user without a UPN by its email as userName', async () => {
    await expect(userNames('userName eq "Grace.Hopper@acme.test"')).resolves.toEqual([
      'grace.hopper@acme.test',
    ]);
  });

  it('does not take a regex in the value as a pattern', async () => {
    await expect(userNames('userName eq "a.*"')).resolves.toEqual([]);
  });

  it('matches emails.value on the email, with co and sw', async () => {
    await expect(userNames('emails.value co "hopper"')).resolves.toEqual([
      'grace.hopper@acme.test',
    ]);
    await expect(userNames('emails.value sw "ALAN"')).resolves.toEqual(['alan.turing@acme.test']);
  });

  it('answers ne with everyone else of the tenant', async () => {
    await expect(userNames('userName ne "alan.turing@acme.test"')).resolves.toEqual([
      'Ada.Lovelace@acme.test',
      'grace.hopper@acme.test',
    ]);
  });

  it('matches displayName', async () => {
    await expect(userNames('displayName eq "grace hopper"')).resolves.toEqual([
      'grace.hopper@acme.test',
    ]);
  });

  it('takes active as the response shows it: ACTIVE or PENDING is active', async () => {
    await expect(userNames('active eq true')).resolves.toEqual([
      'Ada.Lovelace@acme.test',
      'grace.hopper@acme.test',
    ]);
    await expect(userNames('active eq "false"')).resolves.toEqual(['alan.turing@acme.test']);
    await expect(userNames('active ne true')).resolves.toEqual(['alan.turing@acme.test']);
  });

  it('refuses an active filter that is not a boolean comparison', async () => {
    await expect(list('active co "tru"')).rejects.toThrow(SCIMError);
  });

  /**
   * Hunt 2026-11-25 (02 F13): POST checked only that no identity had the userName as its email,
   * but stores the primary email (else the userName) as the email and the userName as the UPN.
   * A body whose email differs from its userName skipped the 409 and was correlated into the
   * identity holding that email (an HR one, say), answering 201 for it.
   */
  describe('POST answers 409 for a user the hub already has', () => {
    const body = (userName: string, email?: string) => ({
      schemas: [SCIM_SCHEMAS.USER],
      userName,
      name: { givenName: 'N', familyName: 'N' },
      ...(email ? { emails: [{ value: email, primary: true }] } : {}),
    });
    const post = (b: ReturnType<typeof body>) =>
      withTenantContext(TENANT, () => scim.create(b, req));

    beforeEach(() => create.mockClear());

    it('refuses an email another identity has, whatever the userName', async () => {
      await expect(
        post(body('new.login@acme.test', 'grace.hopper@acme.test')),
      ).rejects.toMatchObject({ scimStatus: '409', scimType: 'uniqueness' });
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a userName that is another identity UPN, in any case', async () => {
      await expect(post(body('ADA.LOVELACE@acme.test'))).rejects.toMatchObject({
        scimStatus: '409',
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('creates a user nobody has', async () => {
      await post(body('new.person@acme.test'));

      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
