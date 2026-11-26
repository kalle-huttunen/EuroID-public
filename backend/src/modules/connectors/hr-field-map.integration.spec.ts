/**
 * The column map of CSV HR and the field map of JSON API HR, set through the connector API
 * (in-memory MongoDB, the real ConnectorConfigService with encryption and the built-in manifests,
 * the real connectors). Config values are strings and neither manifest offered a map, so both
 * connectors always used their default maps, which fill no employeeNumber: the Brain's "Employee
 * Number" correlation rule got no value from them (browser check of 2026-11-25).
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose, { Model } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { connectTestDb, clearTestDb, closeTestDb, withTestTenant, TEST_TENANT_ID } from '@testing';
import {
  ConnectorConfig,
  ConnectorConfigDocument,
  ConnectorConfigSchema,
} from './schemas/connector-config.schema';
import { ConnectorConfigService } from './connector-config.service';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { registerBuiltInConnectors } from './plugin/register-connectors';
import { CsvHrService } from './csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from './json-api-hr-connector/json-api-hr.service';
import type { JsonApiHrClient } from './json-api-hr-connector/json-api-hr.client';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof ConnectorConfigService>;

const KEY = Buffer.alloc(32, 'k').toString('base64');
/** The column map an admin types into the CSV HR drawer. */
const COLUMN_MAP = JSON.stringify({
  'Personnel No': 'sourceUserId',
  'Given Name': 'firstName',
  Surname: 'lastName',
  'Work Email': 'email',
  'Employee Number': 'employeeNumber',
  'Cost Center': 'customAttributes.costCenter',
});

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => Promise.resolve(withTestTenant(fn));

describe('HR column and field maps through the connector API (MongoDB)', () => {
  let model: Model<ConnectorConfigDocument>;
  let service: ConnectorConfigService;
  let csvDir: string;
  const feed = jest.fn();
  const csvHr = new CsvHrService();
  const jsonHr = new JsonApiHrService({ fetch: feed } as unknown as JsonApiHrClient);

  beforeAll(async () => {
    await connectTestDb();
    model = mongoose.model(
      ConnectorConfig.name,
      ConnectorConfigSchema,
    ) as unknown as Model<ConnectorConfigDocument>;
    const encryption = new EncryptionService({
      get: (key: string) => ({ ENCRYPTION_KEY: KEY })[key.replace(/^encryption\./, '')],
    } as unknown as ConfigService);
    await encryption.onModuleInit();
    const registry = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(registry);
    service = new ConnectorConfigService(
      model as unknown as Ctor[0],
      { logFireAndForget: jest.fn() } as unknown as Ctor[1],
      encryption,
      { getConfig: jest.fn().mockResolvedValue(null) } as unknown as Ctor[3],
      registry,
    );
    // CsvHrService reads files under CSV_HR_ALLOWED_DIR, the working directory without it
    csvDir = fs.mkdtempSync(path.join(process.cwd(), 'test-csv-field-map-'));
  });

  afterEach(async () => {
    feed.mockReset();
    await clearTestDb();
  });

  afterAll(async () => {
    fs.rmSync(csvDir, { recursive: true, force: true });
    await closeTestDb();
  });

  /** The decrypted config the ingest hands to the connector (HrIngestionService). */
  const configOf = async (name: string) =>
    (await inTenant(() => service.getConfig(name)))!.config as unknown as Record<string, unknown>;

  it('CSV HR maps the columns of the installed column map, the employee number included', async () => {
    const filePath = path.join(csvDir, 'hr.csv');
    fs.writeFileSync(
      filePath,
      'Personnel No,Given Name,Surname,Work Email,Employee Number,Cost Center\n' +
        'P-1,Eero,Twinsource,eero@corp.example,E-100,CC-7\n',
    );
    await inTenant(() => service.install('csv-hr', { filePath, columnMap: COLUMN_MAP }));

    const rows = await csvHr.fetchUsers(await configOf('csv-hr'), TEST_TENANT_ID);

    expect(rows).toEqual([
      expect.objectContaining({
        sourceUserId: 'P-1',
        firstName: 'Eero',
        lastName: 'Twinsource',
        email: 'eero@corp.example',
        employeeNumber: 'E-100',
        customAttributes: { costCenter: 'CC-7' },
      }),
    ]);
  });

  it('JSON API HR maps the keys of a field map saved by an update', async () => {
    await inTenant(() => service.install('json-api-hr', { url: 'https://hr.example/api/staff' }));
    await inTenant(() =>
      service.updateConfig('json-api-hr', {
        fieldMap: JSON.stringify({ id: 'sourceUserId', mail: 'email', staff_no: 'employeeNumber' }),
      }),
    );
    feed.mockResolvedValueOnce([{ id: 'J-1', mail: 'eero@corp.example', staff_no: 'E-100' }]);

    const rows = await jsonHr.fetchUsers(await configOf('json-api-hr'), TEST_TENANT_ID);

    expect(rows).toEqual([
      expect.objectContaining({
        sourceUserId: 'J-1',
        email: 'eero@corp.example',
        employeeNumber: 'E-100',
      }),
    ]);
  });

  it('stores the map encrypted with the other config values', async () => {
    await inTenant(() => service.install('csv-hr', { filePath: 'hr.csv', columnMap: COLUMN_MAP }));

    const [doc] = await model.collection.find({}).toArray();
    expect(doc.config).toBeUndefined();
    expect(String(doc.configEncrypted)).not.toContain('Employee Number');
  });

  describe('a map that is wrong is refused with a 400 naming the entry, and nothing is saved', () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        'a field the mapping does not fill',
        JSON.stringify({ Mail: 'email', 'Staff No': 'employeeNo' }),
        /config\.columnMap: "Staff No" maps to "employeeNo", which is not a field/,
      ],
      ['an empty key', JSON.stringify({ Mail: 'email', ' ': 'firstName' }), /a key is empty/],
      ['text that is not JSON', '{Mail: email}', /config\.columnMap: not valid JSON/],
      ['an array', JSON.stringify([['Mail', 'email']]), /must be a JSON object/],
      [
        'a custom attribute without a key',
        JSON.stringify({ Mail: 'email', CC: 'customAttributes.' }),
        /"CC" maps to "customAttributes\."/,
      ],
      ['no email', JSON.stringify({ Id: 'sourceUserId' }), /map a column or key to email/],
    ];

    it.each(cases)('install: %s', async (_case, columnMap, message) => {
      const attempt = inTenant(() => service.install('csv-hr', { filePath: 'hr.csv', columnMap }));

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(message);
      expect(await model.collection.countDocuments()).toBe(0);
    });

    it('update: the stored map stays as it was', async () => {
      await inTenant(() =>
        service.install('csv-hr', { filePath: 'hr.csv', columnMap: COLUMN_MAP }),
      );
      const before = await model.collection.findOne({});

      await expect(
        inTenant(() =>
          service.updateConfig('csv-hr', { columnMap: JSON.stringify({ Mail: 'mail' }) }),
        ),
      ).rejects.toThrow(/"Mail" maps to "mail"/);

      const after = await model.collection.findOne({});
      expect(after!.configEncrypted).toBe(before!.configEncrypted);
    });
  });

  it('an empty map means the default map', async () => {
    const filePath = path.join(csvDir, 'default.csv');
    fs.writeFileSync(filePath, 'EmpID,Email\nD-1,dana@corp.example\n');
    await inTenant(() => service.install('csv-hr', { filePath, columnMap: '' }));

    const rows = await csvHr.fetchUsers(await configOf('csv-hr'), TEST_TENANT_ID);

    expect(rows).toEqual([
      expect.objectContaining({ sourceUserId: 'D-1', email: 'dana@corp.example' }),
    ]);
  });
});
