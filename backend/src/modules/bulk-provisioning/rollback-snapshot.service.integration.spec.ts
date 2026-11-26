import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { closeTestDb, testDbUri } from '@testing/test-db';
import type { Model } from 'mongoose';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { RollbackSnapshotService } from './rollback-snapshot.service';
import {
  RollbackSnapshot,
  RollbackSnapshotSchema,
  type RollbackSnapshotDocument,
} from './schemas/rollback-snapshot.schema';

/**
 * The snapshot a bulk rollback restores is personal data: it must be stored encrypted, be
 * readable only by its own tenant, survive an activity retry unchanged and expire.
 */
describe('RollbackSnapshotService (Integration)', () => {
  let moduleRef: TestingModule;
  let model: Model<RollbackSnapshotDocument>;
  let service: RollbackSnapshotService;
  const attributes = { mobilePhone: '+358 40 765 4321', jobTitle: 'Analyst' };

  beforeAll(async () => {
    const key = Buffer.alloc(32, 'k').toString('base64');
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: RollbackSnapshot.name, schema: RollbackSnapshotSchema },
        ]),
      ],
      providers: [
        RollbackSnapshotService,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) => (name === 'encryption.ENCRYPTION_KEY' ? key : undefined),
          },
        },
      ],
    }).compile();
    await moduleRef.init();
    service = moduleRef.get(RollbackSnapshotService);
    model = moduleRef.get(getModelToken(RollbackSnapshot.name));
    await model.syncIndexes();
  });

  afterAll(async () => {
    await moduleRef?.close();
    await closeTestDb();
  });

  it('stores the state encrypted and gives it back to the same tenant', async () => {
    const ref = await service.save('tenant-a', 'entra-attributes', attributes);

    const stored = await model.findById(ref).lean();
    expect(JSON.stringify(stored)).not.toContain('765 4321');
    expect(stored?.ciphertext).toMatch(/^euroid:v2:/);
    await expect(service.load('tenant-a', 'entra-attributes', ref)).resolves.toEqual(attributes);
  });

  it('gives nothing to another tenant, for another kind or for a malformed reference', async () => {
    const ref = await service.save('tenant-a', 'entra-attributes', attributes);

    await expect(service.load('tenant-b', 'entra-attributes', ref)).resolves.toBeNull();
    await expect(service.load('tenant-a', 'hub-identity', ref)).resolves.toBeNull();
    await expect(service.load('tenant-a', 'entra-attributes', 'not-an-id')).resolves.toBeNull();
  });

  it('keeps the first snapshot when a retried activity saves again under the same key', async () => {
    const first = await service.save('tenant-a', 'hub-identity', { existed: false }, 'run-1/op-1');
    const retry = await service.save(
      'tenant-a',
      'hub-identity',
      { existed: true, identity: { profile: { email: 'changed@example.com' } } },
      'run-1/op-1',
    );

    expect(retry).toBe(first);
    await expect(service.load('tenant-a', 'hub-identity', first)).resolves.toEqual({
      existed: false,
    });
    // The same key under another tenant is another snapshot.
    const other = await service.save('tenant-b', 'hub-identity', { existed: false }, 'run-1/op-1');
    expect(other).not.toBe(first);
  });

  it('expires snapshots after ROLLBACK_SNAPSHOT_TTL_HOURS (default 24)', async () => {
    const indexes = await model.collection.indexes();

    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { createdAt: 1 }, expireAfterSeconds: 24 * 3600 }),
    );
  });
});
