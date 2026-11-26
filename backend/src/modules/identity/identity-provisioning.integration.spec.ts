/**
 * What IdentityProvisioningService.updateProvisioningState stores on the identity, read back
 * from in-memory MongoDB with the real Identity schema and tenant plugin: a new entry for a
 * target the identity has none for, the status and error of an existing entry, the time-bound
 * fields and the writeback flag.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { closeTestDb, createMockLoggerFactory, testDbUri } from '@testing';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { IdentityProvisioningService } from './identity-provisioning.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const EXPIRES = new Date('2026-12-31T00:00:00.000Z');
const ACTIVE_FROM = new Date('2026-01-01T00:00:00.000Z');

/** updateProvisioningState's arguments after the identity id. */
type UpdateArgs =
  Parameters<IdentityProvisioningService['updateProvisioningState']> extends [string, ...infer R]
    ? R
    : never;

describe('IdentityProvisioningService.updateProvisioningState (MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: IdentityProvisioningService;
  let identities: Model<IdentityDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
      ],
      providers: [
        IdentityProvisioningService,
        { provide: LoggerFactoryService, useValue: createMockLoggerFactory().factory },
      ],
    }).compile();
    service = moduleRef.get(IdentityProvisioningService);
    identities = moduleRef.get(getModelToken(Identity.name));
  });

  beforeEach(async () => {
    await identities.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  it.each<[string, Array<Record<string, unknown>>, UpdateArgs, Record<string, unknown>]>([
    [
      'a new entry for a target the identity has none for',
      [],
      ['entra-id', 'SYNCED'],
      {
        status: 'SYNCED',
        provisionedAt: expect.any(Date),
        lastSync: expect.any(Date),
        writebackComplete: false,
      },
    ],
    [
      'the status and error of an existing entry',
      [{ targetSystem: 'entra-id', status: 'PENDING' }],
      ['entra-id', 'ERROR', 'Connection timeout'],
      { status: 'ERROR', errorMsg: 'Connection timeout', lastSync: expect.any(Date) },
    ],
    [
      'the time-bound fields',
      [],
      [
        'entra-id',
        'SYNCED',
        undefined,
        undefined,
        { expiresAt: EXPIRES, activeFrom: ACTIVE_FROM, grantedBy: 'request' },
      ],
      { status: 'SYNCED', expiresAt: EXPIRES, activeFrom: ACTIVE_FROM, grantedBy: 'request' },
    ],
    [
      'the writeback flag',
      [{ targetSystem: 'entra-id', status: 'SYNCED', lastSync: new Date('2026-11-01') }],
      ['entra-id', 'SYNCED', undefined, true],
      { status: 'SYNCED', writebackComplete: true },
    ],
  ])('stores %s', async (_label, existing, args, expected) => {
    const { _id } = await withTenantContext(A, () =>
      identities.create({
        tenantId: A,
        profile: { firstName: 'Ada', lastName: 'Test', email: 'ada@a.example' },
        provisioning: existing,
      }),
    );
    const id = String(_id);

    await withTenantContext(A, () => service.updateProvisioningState(id, ...args));

    const stored = await identities.findById(id).setOptions({ skipTenantScope: true }).lean();
    expect(stored!.provisioning).toHaveLength(1);
    expect(stored!.provisioning[0]).toMatchObject({ targetSystem: 'entra-id', ...expected });
  });
});
