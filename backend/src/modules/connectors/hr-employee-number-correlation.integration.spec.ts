/**
 * The employeeNumber correlation rule on HR rows (in-memory MongoDB, the real CSV HR and JSON API
 * HR mapping, correlation, rule engine and reconciliation). Both connectors dropped a column or
 * key mapped to `employeeNumber`, so `sources.rawData.employeeNumber` stayed empty and the rule
 * the Brain offers never matched an HR row: two HR sources with one person's employee number made
 * two identities (browser check of 2026-11-24).
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose, { Model } from 'mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { StandardUserSchema, type StandardUserDto } from '@shared/dtos/standard-user.dto';
import {
  connectTestDb,
  clearTestDb,
  closeTestDb,
  createMockEventEmitter,
  createMockLoggerFactory,
  withTestTenant,
  TEST_TENANT_ID,
} from '@testing';
import {
  Identity,
  IdentitySchema,
  type IdentityDocument,
} from '../identity/schemas/identity.schema';
import { IdentityCorrelationService } from '../identity/identity-correlation.service';
import { IdentityOnionService } from '../identity/identity-onion.service';
import { IdentityDeletedMatchService } from '../identity/identity-deleted-match.service';
import { ReconciliationService } from '../identity/reconciliation.service';
import { ReconciliationConfigService } from '../identity/reconciliation-config.service';
import { CorrelationRuleEngine } from '../identity/correlation/correlation-rule.engine';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { CsvHrService } from './csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from './json-api-hr-connector/json-api-hr.service';
import type { JsonApiHrClient } from './json-api-hr-connector/json-api-hr.client';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

const CSV_HR = 'csv-hr';
const JSON_HR = 'json-api-hr';

const model = <T>(name: string, schema: mongoose.Schema) =>
  (mongoose.models[name] ?? mongoose.model(name, schema)) as unknown as Model<T>;

describe('HR rows correlated by employee number (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let identityModel: Model<IdentityDocument>;
  let csvDir: string;
  const feed = jest.fn();
  const csvHr = new CsvHrService();
  const jsonHr = new JsonApiHrService({ fetch: feed } as unknown as JsonApiHrClient);

  beforeAll(async () => {
    await connectTestDb();
    identityModel = model<IdentityDocument>(Identity.name, IdentitySchema);
    const policyModel = model<LeaverPolicy>(LeaverPolicy.name, LeaverPolicySchema);
    await identityModel.syncIndexes(); // the unique email index production has
    const { factory: loggerFactory } = createMockLoggerFactory();
    moduleRef = await Test.createTestingModule({
      providers: [
        IdentityCorrelationService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        ReconciliationService,
        CorrelationRuleEngine,
        { provide: getModelToken(Identity.name), useValue: identityModel },
        { provide: getModelToken(LeaverPolicy.name), useValue: policyModel },
        {
          provide: ReconciliationConfigService,
          useValue: { getConfig: async () => null, getHrSourceTags: async () => [] },
        },
        {
          provide: CorrelationConfigService,
          useValue: {
            // The rule an admin picks as "Employee Number" in the Brain, alone
            getCorrelationConfig: async () => ({
              rules: [{ strategy: 'employeeNumber' }],
              conflictAction: 'review',
              confidenceThreshold: 0.7,
            }),
            getPrimaryHrSourceName: async () => null,
            getHrPriorityConfig: async () => null,
            getHrPriorityFromBlueprint: async () => null,
            getHrConnectorsWithPriorityFromBlueprint: async () => [],
            getInstalledHrConnectorsWithPriority: async () => [],
            isHrSourceName: async (name: string) => name === CSV_HR || name === JSON_HR,
          },
        },
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: createMockEventEmitter() },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    // CsvHrService reads files under CSV_HR_ALLOWED_DIR, the working directory without it
    csvDir = fs.mkdtempSync(path.join(process.cwd(), 'test-csv-employee-number-'));
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    fs.rmSync(csvDir, { recursive: true, force: true });
    await moduleRef?.close();
    await closeTestDb();
  });

  /** The rows CSV HR maps from this file, with the employee number column mapped. */
  async function csvRows(content: string): Promise<Partial<StandardUserDto>[]> {
    const filePath = path.join(csvDir, 'hr.csv');
    fs.writeFileSync(filePath, content);
    return csvHr.fetchUsers(
      {
        filePath,
        columnMap: {
          EmpID: 'sourceUserId',
          'First Name': 'firstName',
          'Last Name': 'lastName',
          Email: 'email',
          'Employee Number': 'employeeNumber',
        },
      },
      TEST_TENANT_ID,
    );
  }

  /** The rows JSON API HR maps from this feed, with the staff number key mapped. */
  async function jsonRows(items: Array<Record<string, unknown>>) {
    feed.mockResolvedValueOnce(items);
    return jsonHr.fetchUsers(
      {
        url: 'https://hr.example/api/people',
        fieldMap: {
          id: 'sourceUserId',
          given: 'firstName',
          family: 'lastName',
          mail: 'email',
          staff_no: 'employeeNumber',
        },
      },
      TEST_TENANT_ID,
    );
  }

  /** What the HR ingest hands the Hub for each fetched row: the row validated, then saved. */
  async function ingest(rows: Partial<StandardUserDto>[]): Promise<void> {
    for (const row of rows) {
      await correlation.ensureIdentityFromUser(StandardUserSchema.parse(row) as StandardUserDto);
    }
  }

  it('joins two HR sources that share an employee number into one identity', async () =>
    await withTestTenant(async () => {
      await ingest(
        await csvRows(
          'EmpID,First Name,Last Name,Email,Employee Number\n' +
            'C-1,Ada,Lovelace,ada@corp.example,E-100\n',
        ),
      );
      // The same person in the second source: another HR id and another address, so only the
      // employee number can match her; and a second person with another employee number
      await ingest(
        await jsonRows([
          {
            id: 'J-1',
            given: 'Ada',
            family: 'Lovelace',
            mail: 'ada.lovelace@contractor.example',
            staff_no: 'E-100',
          },
          {
            id: 'J-2',
            given: 'Grace',
            family: 'Hopper',
            mail: 'grace@contractor.example',
            staff_no: 'E-200',
          },
        ]),
      );

      const identities = await identityModel.find({}).sort({ _id: 1 }).lean().exec();
      expect(identities).toHaveLength(2);
      const [ada, grace] = identities;
      const adaSources = ada.sources.map((s) => [
        s.sourceName,
        s.externalId,
        s.rawData.employeeNumber,
      ]);
      expect(adaSources).toEqual([
        [CSV_HR, 'C-1', 'E-100'],
        [JSON_HR, 'J-1', 'E-100'],
      ]);
      expect(ada.metadata?.correlationStatus).toBe('correlated');
      expect(grace.sources.map((s) => `${s.sourceName}/${s.externalId}`)).toEqual([
        `${JSON_HR}/J-2`,
      ]);
    }));
});
