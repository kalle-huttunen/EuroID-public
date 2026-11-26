/**
 * ConnectorConfigService on in-memory MongoDB with the real EncryptionService: a process whose
 * keys cannot decrypt a stored connector config fails and writes nothing, and a sync status
 * update stores what the last run reported, nothing older.
 */
import mongoose, { Model } from 'mongoose';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { SECRET_PLACEHOLDER } from '@infrastructure/secrets/config-secret-mask';
import { connectTestDb, clearTestDb, closeTestDb, withTestTenant } from '@testing';
import {
  ConnectorConfig,
  ConnectorConfigDocument,
  ConnectorConfigSchema,
} from './schemas/connector-config.schema';
import { ConnectorConfigService } from './connector-config.service';
import { ConnectorConfigDecryptError } from './connector-config.errors';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { registerBuiltInConnectors } from './plugin/register-connectors';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof ConnectorConfigService>;

const KEY_A = Buffer.alloc(32, 'a').toString('base64');
const KEY_B = Buffer.alloc(32, 'b').toString('base64');
const GITHUB = { orgName: 'acme', personalAccessToken: 'ghp_s3cret-token' };
const CSV_HR = { filePath: '/data/hr.csv', sourceSystem: 'Workday Export' };

/** `fn` in the test tenant's context, as a request or an activity runs it. */
const inTenant = <T>(fn: () => Promise<T>): Promise<T> => Promise.resolve(withTestTenant(fn));

/** EncryptionService with these settings (ENCRYPTION_KEY, ...); keys loaded unless `load` false. */
async function encryptionWith(settings: Record<string, string>, load = true) {
  const config = {
    get: (key: string) => settings[key.replace(/^encryption\./, '')],
  } as unknown as ConfigService;
  const encryption = new EncryptionService(config);
  if (load) await encryption.onModuleInit();
  return encryption;
}

describe('ConnectorConfigService (in-memory MongoDB, real encryption)', () => {
  let model: Model<ConnectorConfigDocument>;

  const serviceWith = (encryption: EncryptionService) => {
    const registry = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(registry);
    return new ConnectorConfigService(
      model as unknown as Ctor[0],
      { logFireAndForget: jest.fn() } as unknown as Ctor[1],
      encryption,
      { getConfig: jest.fn().mockResolvedValue(null) } as unknown as Ctor[3],
      registry,
    );
  };

  /** The stored documents as MongoDB holds them, without Mongoose. */
  const stored = () => model.collection.find({}).sort({ connectorName: 1 }).toArray();

  beforeAll(async () => {
    await connectTestDb();
    model = mongoose.model(
      ConnectorConfig.name,
      ConnectorConfigSchema,
    ) as unknown as Model<ConnectorConfigDocument>;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe('a stored config this process cannot decrypt', () => {
    /** github and csv-hr installed by a process with `saver`'s keys. */
    async function installedWith(saver: Record<string, string>) {
      const service = serviceWith(await encryptionWith(saver));
      await inTenant(async () => {
        await service.install('github', GITHUB);
        await service.install('csv-hr', CSV_HR);
      });
      return stored();
    }

    it('fails with a 503 naming the connector and writes nothing (another ENCRYPTION_KEY)', async () => {
      const before = await installedWith({ ENCRYPTION_KEY: KEY_A });
      const service = serviceWith(await encryptionWith({ ENCRYPTION_KEY: KEY_B }));

      const error = await inTenant(() => service.getConfig('github')).catch((e) => e);

      expect(error).toBeInstanceOf(ConnectorConfigDecryptError);
      expect((error as ConnectorConfigDecryptError).getStatus()).toBe(503);
      expect((error as Error).message).toMatch(/connector "github" could not be decrypted/);
      expect((error as Error).message).toMatch(/ENCRYPTION_KEY/);
      expect(await stored()).toEqual(before);
    });

    it('fails and writes nothing when its key id is missing from the key ring', async () => {
      const before = await installedWith({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k2' });
      const service = serviceWith(
        await encryptionWith({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k1' }),
      );

      await expect(inTenant(() => service.getConfig('github'))).rejects.toBeInstanceOf(
        ConnectorConfigDecryptError,
      );
      expect(await stored()).toEqual(before);
    });

    it('read before the keys are loaded: a retryable "not loaded yet" error, not a wrong key', async () => {
      const before = await installedWith({ ENCRYPTION_KEY: KEY_A });
      const service = serviceWith(await encryptionWith({ ENCRYPTION_KEY: KEY_A }, false));

      const error = await inTenant(() => service.getConfig('github')).catch((e) => e);

      expect(error).toBeInstanceOf(ConnectorConfigDecryptError);
      expect((error as ConnectorConfigDecryptError).getStatus()).toBe(503);
      expect((error as Error).message).toMatch(/has not loaded its encryption keys/);
      expect((error as Error).message).not.toMatch(/could not be decrypted/);
      expect(await stored()).toEqual(before);
    });

    it.each<[string, (s: ConnectorConfigService) => Promise<unknown>]>([
      ['GET /connectors (listInstalled)', (s) => s.listInstalled()],
      [
        'an update that keeps the stored secret',
        (s) => s.updateConfig('github', { ...GITHUB, personalAccessToken: SECRET_PLACEHOLDER }),
      ],
      [
        'a health check on form values',
        (s) =>
          s.withStoredSecrets('github', { ...GITHUB, personalAccessToken: SECRET_PLACEHOLDER }),
      ],
      ['the HR source lookup', (s) => s.isHrSourceName('workday-export')],
      ['the legacy primary HR lookup', (s) => s.getPrimaryHrSourceName([])],
    ])('%s fails the same way and writes nothing', async (_name, call) => {
      const before = await installedWith({ ENCRYPTION_KEY: KEY_A });
      const service = serviceWith(await encryptionWith({ ENCRYPTION_KEY: KEY_B }));

      await expect(inTenant(() => call(service))).rejects.toBeInstanceOf(
        ConnectorConfigDecryptError,
      );
      expect(await stored()).toEqual(before);
    });

    it('logs the connector and tenant, never the key, the ciphertext or a config value', async () => {
      const before = await installedWith({ ENCRYPTION_KEY: KEY_A });
      const service = serviceWith(await encryptionWith({ ENCRYPTION_KEY: KEY_B }));
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const error = await inTenant(() => service.getConfig('github')).catch((e) => e);

      const text = JSON.stringify([logged.mock.calls, (error as Error).message]);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/github \(tenant test-tenant\)/));
      const ciphertext = String(before.find((d) => d.connectorName === 'github')?.configEncrypted);
      for (const secret of [KEY_A, KEY_B, ciphertext, ciphertext.split(':')[3], 'ghp_s3cret']) {
        expect(text).not.toContain(secret);
      }
    });

    it('an admin replaces it by installing again (lost key) or removes it by uninstalling', async () => {
      await installedWith({ ENCRYPTION_KEY: KEY_A });
      const service = serviceWith(await encryptionWith({ ENCRYPTION_KEY: KEY_B }));
      const renewed = { orgName: 'acme', personalAccessToken: 'ghp_new' };

      await inTenant(async () => {
        await service.install('github', renewed);
        expect((await service.getConfig('github'))?.config).toEqual(renewed);
        await service.uninstall('csv-hr');
      });

      expect((await stored()).map((d) => d.connectorName)).toEqual(['github']);
    });

    it('the health readiness read needs no decrypt: names and last sync of every connector', async () => {
      await installedWith({ ENCRYPTION_KEY: KEY_A });
      const service = serviceWith(await encryptionWith({ ENCRYPTION_KEY: KEY_B }));
      const syncedAt = new Date('2026-11-20T08:00:00.000Z');
      await inTenant(() =>
        service.updateSyncStatus('csv-hr', { lastSyncAt: syncedAt, lastSyncStatus: 'success' }),
      );

      const states = await inTenant(() => service.listSyncStates());

      expect(states).toEqual([
        expect.objectContaining({ connectorName: 'github' }),
        expect.objectContaining({
          connectorName: 'csv-hr',
          lastSyncAt: syncedAt,
          lastSyncStatus: 'success',
        }),
      ]);
      expect(JSON.stringify(states)).not.toContain('configEncrypted');
    });
  });

  describe('updateSyncStatus', () => {
    const at = (iso: string) => new Date(`2026-11-${iso}T08:00:00.000Z`);

    async function installed() {
      const service = serviceWith(await encryptionWith({ ENCRYPTION_KEY: KEY_A }));
      await inTenant(() => service.install('csv-hr', CSV_HR));
      return service;
    }
    const storedStatus = async () => {
      const [doc] = await stored();
      return {
        lastSyncAt: doc.lastSyncAt,
        lastSyncStatus: doc.lastSyncStatus,
        lastSyncCount: doc.lastSyncCount,
        lastSyncError: doc.lastSyncError,
        has: { count: 'lastSyncCount' in doc, error: 'lastSyncError' in doc },
      };
    };

    it('a sync without row errors removes the error a previous run stored', async () => {
      const service = await installed();
      await inTenant(async () => {
        // Stored before plan item 2.0dd masked emails in row errors
        await service.updateSyncStatus('csv-hr', {
          lastSyncAt: at('20'),
          lastSyncStatus: 'success',
          lastSyncCount: 9,
          lastSyncError: 'Row 4 (ada@acme.test): email: Invalid email',
        });
        await service.updateSyncStatus('csv-hr', {
          lastSyncAt: at('21'),
          lastSyncStatus: 'success',
          lastSyncCount: 10,
          lastSyncError: undefined,
        });
      });

      expect(await storedStatus()).toEqual({
        lastSyncAt: at('21'),
        lastSyncStatus: 'success',
        lastSyncCount: 10,
        lastSyncError: undefined,
        has: { count: true, error: false },
      });
    });

    it('a failed run without a count removes the count of an earlier run', async () => {
      const service = await installed();
      await inTenant(async () => {
        await service.updateSyncStatus('csv-hr', {
          lastSyncAt: at('20'),
          lastSyncStatus: 'success',
          lastSyncCount: 120,
        });
        await service.updateSyncStatus('csv-hr', {
          lastSyncAt: at('21'),
          lastSyncStatus: 'failed',
          lastSyncError: 'Data synchronization failed',
        });
      });

      expect(await storedStatus()).toEqual({
        lastSyncAt: at('21'),
        lastSyncStatus: 'failed',
        lastSyncCount: undefined,
        lastSyncError: 'Data synchronization failed',
        has: { count: false, error: true },
      });
    });
  });
});
