/**
 * Contract of POST /blueprints/save with the body the Design studio builds.
 *
 * test/fixtures/blueprint-save-correlation.payload.json is pinned by the frontend test
 * (frontend/src/features/blueprints/hooks/__tests__/correlation-save-contract.test.tsx) to what
 * useCanvasLoadAndSave sends when the Identity Correlation tab saves: the whole canvas with
 * connectorConfigs['euroid-core'] = { correlationConfig } and other connectors' configs as GET
 * returned them (secrets masked). The API must accept it, store the correlation settings the
 * correlation engine reads, keep masked secrets, and answer any invalid body with 400, never 500.
 *
 * test/fixtures/blueprint-save-edge-conditions.payload.json is pinned the same way
 * (edge-condition-save-contract.test.tsx) to the canvas save after an admin sets flow conditions
 * on a Brain -> target edge: the edges carry them in `data`, with their labels and styles. The
 * API must store them so GET /blueprints/latest and provisioning (getEdgeConditions) read them.
 *
 * test/fixtures/blueprint-save-policy-nodes.payload.json (policy-nodes-save-contract.test.tsx) is
 * the same canvas after an admin adds a condition and an action from the NodePalette and connects
 * them: the policy nodes and their edge are saved with the connector graph and must load back.
 *
 * A Field Mastery owner other than the primary HR contract for a contract-critical field (Recon
 * Config) is refused with 400 and nothing stored (owner decision 2026-11-24); the check is the real
 * ContractCriticalMasteryService behind IdentityService.assertCanvasMastery.
 *
 * The pinned correlation body has a Hashed National ID rule, which the API accepts only while the
 * server has CORRELATION_HMAC_SECRET (16+ characters): without it national IDs would be dropped
 * unhashed at ingest (FOLLOWUPS 2026-11-25, correlation-hash.service.ts), so the save is refused
 * and the admin learns it before a sync. The suite runs with the secret set unless a test says
 * otherwise.
 */

import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost, type ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as request from 'supertest';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { authConfig } from '@infrastructure/config/auth.config';
import { BlueprintsController } from './blueprints.controller';
import { BlueprintsService } from './blueprints.service';
import { ImpactAnalysisService } from './impact-analysis.service';
import { PipelineService } from './pipeline.service';
import { IdentityService } from '../identity/identity.service';
import { ContractCriticalMasteryService } from '../identity/contract-critical-mastery.service';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../connectors/plugin/register-connectors';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'tenant-a' }),
}));

type ServiceCtor = ConstructorParameters<typeof BlueprintsService>;
type Doc = Record<string, unknown>;

const FIXTURE = resolve(
  __dirname,
  '../../../test/fixtures/blueprint-save-correlation.payload.json',
);
const designStudioBody = (): Doc => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const EDGE_FIXTURE = resolve(
  __dirname,
  '../../../test/fixtures/blueprint-save-edge-conditions.payload.json',
);
const edgeConditionBody = (): Doc => JSON.parse(readFileSync(EDGE_FIXTURE, 'utf8'));
const POLICY_FIXTURE = resolve(
  __dirname,
  '../../../test/fixtures/blueprint-save-policy-nodes.payload.json',
);
const policyNodesBody = (): Doc => JSON.parse(readFileSync(POLICY_FIXTURE, 'utf8'));
const OKTA_TOKEN = 'okta-api-token-stored';
const CORRELATION_SECRET = 'correlation-secret-for-tests-0123456789';

const ENC = 'enc:';
const encryption = {
  encrypt: (plain: string) => ENC + Buffer.from(plain).toString('base64'),
  decrypt: (cipher: string) => Buffer.from(cipher.slice(ENC.length), 'base64').toString(),
  isEncrypted: (value: string) => value.startsWith(ENC),
};

describe('POST /blueprints/save contract (Design studio body)', () => {
  let app: INestApplication;
  let service: BlueprintsService;
  let canvas: Doc | null;
  /** The tenant's Recon Config the mastery check reads (none: no field is contract-critical). */
  const reconConfig = { getConfig: jest.fn() };
  /** IdentityService.cleanStoredNationalIds: the cleanup a new national ID field starts. */
  const cleanStoredNationalIds = jest.fn().mockResolvedValue(null);
  const mastery = new ContractCriticalMasteryService(
    reconConfig as never,
    {
      getHrConnectorsWithPriorityFromBlueprint: async () => [],
      getInstalledHrConnectorsWithPriority: async () => [],
    } as never,
  );

  beforeAll(async () => {
    const registry = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(registry);
    const withToObject = (doc: Doc) => ({ ...doc, toObject: () => ({ ...doc }) });
    const canvasModel = {
      findOne: jest.fn(async () => (canvas ? withToObject(canvas) : null)),
      findOneAndUpdate: jest.fn(async (_filter: unknown, update: { $set: Doc }) => {
        canvas = { ...canvas, ...update.$set, _id: 'canvas-1', updatedAt: new Date() };
        return withToObject(canvas);
      }),
    };
    service = new BlueprintsService(
      {} as ServiceCtor[0],
      canvasModel as unknown as ServiceCtor[1],
      { logFireAndForget: jest.fn() } as unknown as ServiceCtor[2],
      encryption as unknown as ServiceCtor[3],
      registry,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [BlueprintsController],
      providers: [
        { provide: BlueprintsService, useValue: service },
        { provide: ImpactAnalysisService, useValue: {} },
        { provide: PipelineService, useValue: {} },
        {
          provide: IdentityService,
          useValue: {
            assertCanvasMastery: (c: never) => mastery.assertCanvas(c),
            cleanStoredNationalIds,
          },
        },
        { provide: EntraService, useValue: {} },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'tenant-a' } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // As main.ts: an unmapped error becomes a generic 500, a thrown ZodError a 400.
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  const originalSecret = process.env.CORRELATION_HMAC_SECRET;

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.CORRELATION_HMAC_SECRET;
    else process.env.CORRELATION_HMAC_SECRET = originalSecret;
  });

  beforeEach(async () => {
    process.env.CORRELATION_HMAC_SECRET = CORRELATION_SECRET;
    reconConfig.getConfig.mockResolvedValue(null);
    canvas = null;
    // The stored canvas the Design studio loaded: the Okta token in clear server-side.
    await service.saveBlueprint({
      nodes: [],
      edges: [],
      connectorConfigs: { okta: { orgUrl: 'https://dev.okta.example', apiToken: OKTA_TOKEN } },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const save = (body: object) => request(app.getHttpServer()).post('/blueprints/save').send(body);

  it('accepts the correlation save and stores the settings the correlation engine reads', async () => {
    const body = designStudioBody();

    const res = await save(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, nodeCount: 3, edgeCount: 2 });
    const stored = await service.getLatestBlueprint();
    const sent = (body.connectorConfigs as Record<string, Doc>)['euroid-core'];
    expect(stored.connectorConfigs['euroid-core']).toEqual(sent);
    expect(stored.connectorConfigs['euroid-core'].correlationConfig).toMatchObject({
      rules: expect.arrayContaining([
        { strategy: 'hashedNationalId', nationalIdSourceField: 'hetu' },
        { strategy: 'heuristicName', nameMatchThreshold: 0.85, nameMatchMode: 'fuzzy' },
      ]),
      conflictAction: 'auto-link',
      fieldMasteryOverrides: { email: ['okta'], jobTitle: ['csv-hr'] },
      hrWriteback: true,
      targetWriteback: false,
    });
    // The Okta token came back masked from GET and was sent as is: the stored value stays.
    expect(stored.connectorConfigs.okta).toEqual({
      orgUrl: 'https://dev.okta.example',
      apiToken: OKTA_TOKEN,
    });
  });

  // HX-F report follow-up: a save of a canvas someone saved since it was loaded is refused
  it('answers 409 with what to do, and stores nothing, for a revision that is not the stored one', async () => {
    const before = await service.getLatestBlueprint();

    const res = await save({ ...designStudioBody(), revision: 3 });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/you loaded revision 3, it is now 0.*Reload the canvas/);
    expect((await service.getLatestBlueprint()).connectorConfigs).toEqual(before.connectorConfigs);
  });

  it('refuses a revision that is no whole number with 400', async () => {
    const res = await save({ ...designStudioBody(), revision: 'latest' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('revision');
  });

  // Package F's follow-up: values stored under the rule's field before it named it stay raw
  it('starts the stored national ID cleanup with the settings before and after the save', async () => {
    cleanStoredNationalIds.mockClear();
    const body = designStudioBody();

    await save(body).expect(201);

    const sent = (body.connectorConfigs as Record<string, Doc>)['euroid-core'];
    expect(cleanStoredNationalIds).toHaveBeenCalledWith(
      'tenant-a',
      undefined,
      sent.correlationConfig,
    );
    // A failed cleanup is logged; the save stands
    cleanStoredNationalIds.mockRejectedValueOnce(new Error('connection reset'));
    await save(body).expect(201);
    expect(cleanStoredNationalIds).toHaveBeenLastCalledWith(
      'tenant-a',
      sent.correlationConfig,
      sent.correlationConfig,
    );
  });

  it('accepts a stored correlation config saved back as loaded (rules only)', async () => {
    const body = designStudioBody();
    body.connectorConfigs = {
      'euroid-core': { correlationConfig: { rules: [{ strategy: 'email' }] } },
    };

    await save(body).expect(201);
  });

  it.each<[string, (body: Doc) => void, string]>([
    [
      'an unknown correlation strategy',
      (b) => (correlation(b).rules = [{ strategy: 'shoe-size' }]),
      'connectorConfigs.euroid-core.correlationConfig.rules.0.strategy',
    ],
    [
      'a name match threshold above 1',
      (b) => (correlation(b).rules = [{ strategy: 'heuristicName', nameMatchThreshold: 85 }]),
      'connectorConfigs.euroid-core.correlationConfig.rules.0.nameMatchThreshold',
    ],
    [
      'a conflict action the engine does not know',
      (b) => (correlation(b).conflictAction = 'delete-both'),
      'connectorConfigs.euroid-core.correlationConfig.conflictAction',
    ],
    [
      'field mastery as a single owner instead of a priority list',
      (b) => (correlation(b).fieldMasteryOverrides = { email: 'okta' }),
      'connectorConfigs.euroid-core.correlationConfig.fieldMasteryOverrides.email',
    ],
    [
      'a connector config that is not an object',
      (b) => ((b.connectorConfigs as Doc).okta = 'https://dev.okta.example'),
      'connectorConfigs.okta',
    ],
    ['a node without an id', (b) => ((b.nodes as Doc[])[0].id = ''), 'nodes.0.id'],
    ['no nodes array', (b) => delete b.nodes, 'nodes'],
  ])('answers %s with 400 naming the field, and stores nothing', async (_name, corrupt, path) => {
    const body = designStudioBody();
    corrupt(body);
    const before = JSON.stringify(canvas);

    const res = await save(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^${escape(path)}: `))]),
    );
    expect(JSON.stringify(canvas)).toBe(before);
  });

  it.each<[string, string | undefined]>([
    ['not set', undefined],
    ['shorter than 16 characters', 'x'.repeat(15)],
  ])(
    'refuses a Hashed National ID rule while CORRELATION_HMAC_SECRET is %s, and stores nothing',
    async (_case, secret) => {
      if (secret === undefined) delete process.env.CORRELATION_HMAC_SECRET;
      else process.env.CORRELATION_HMAC_SECRET = secret;
      const body = designStudioBody(); // its second rule is Hashed National ID (field hetu)
      const before = JSON.stringify(canvas);

      const res = await save(body);

      expect(res.status).toBe(400);
      const path = 'connectorConfigs.euroid-core.correlationConfig.rules.1.strategy';
      expect(res.body.message).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(`^${escape(path)}: .*CORRELATION_HMAC_SECRET.*dropped without being hashed`),
          ),
        ]),
      );
      expect(JSON.stringify(canvas)).toBe(before);
    },
  );

  it('accepts a correlation config without Hashed National ID while the secret is not set', async () => {
    delete process.env.CORRELATION_HMAC_SECRET;
    const body = designStudioBody();
    correlation(body).rules = [{ strategy: 'employeeNumber' }, { strategy: 'email' }];

    await save(body).expect(201);
  });

  it('refuses a Field Mastery owner other than the primary HR source for a contract-critical field', async () => {
    reconConfig.getConfig.mockResolvedValue({
      hrSourceTags: ['csv-hr'],
      sourcePriorityOrder: ['csv-hr'],
      contractCriticalFields: ['jobTitle', 'departmentName'],
      defaultMastery: {},
      targetIdKeys: [],
    });
    const body = designStudioBody();
    // The pinned body names csv-hr (the only HR source node, so the primary) for jobTitle
    await save(body).expect(201);
    correlation(body).fieldMasteryOverrides = { departmentName: ['okta'] };
    const before = JSON.stringify(canvas);

    const res = await save(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Field Mastery: departmentName names okta');
    expect(res.body.message).toContain('Contract Tag and ingest priority');
    expect(JSON.stringify(canvas)).toBe(before);
  });

  describe('edge flow conditions', () => {
    const load = async () =>
      (await request(app.getHttpServer()).get('/blueprints/latest').expect(200)).body.data;
    const edge = (body: Doc, id: string) => (body.edges as Doc[]).find((e) => e.id === id) as Doc;

    it('stores the edges with their conditions, labels and styles, and loads them back', async () => {
      const body = edgeConditionBody();

      await save(body).expect(201);

      const loaded = await load();
      expect(loaded.edges).toEqual(body.edges);
      expect(edge(loaded, 'core-entra').data).toEqual({
        conditionsEnabled: true,
        conditionGroups: [
          expect.objectContaining({
            join: 'AND',
            conditions: [
              expect.objectContaining({ field: 'status', operator: 'equals', value: 'Active' }),
            ],
          }),
        ],
      });
      expect(edge(loaded, 'core-okta-target-1').data).toEqual(
        edge(body, 'core-okta-target-1').data,
      );
      expect((loaded.nodes as Doc[]).map((n) => n.style)).toEqual(
        (body.nodes as Doc[]).map((n) => n.style),
      );
      // What provisioning reads (config.activities getEdgeConditions): the stored edge data.
      const stored = await service.getLatestBlueprint();
      expect(edge(stored as unknown as Doc, 'core-entra').data).toEqual(
        edge(body, 'core-entra').data,
      );
    });

    it('drops React Flow UI state and unknown keys instead of storing them', async () => {
      const body = edgeConditionBody();
      Object.assign(edge(body, 'core-entra'), { selected: true });
      Object.assign(edge(body, 'core-entra').data as Doc, { highlighted: true });
      Object.assign((body.nodes as Doc[])[0], { measured: { width: 180, height: 40 } });

      await save(body).expect(201);

      const loaded = await load();
      expect(edge(loaded, 'core-entra')).not.toHaveProperty('selected');
      expect(edge(loaded, 'core-entra').data).not.toHaveProperty('highlighted');
      expect((loaded.nodes as Doc[])[0]).not.toHaveProperty('measured');
    });

    it.each<[string, (cond: Doc, group: Doc, edgeDoc: Doc) => void, string]>([
      [
        'an operator provisioning cannot evaluate',
        (c) => (c.operator = 'regex'),
        'edges.2.data.conditionGroups.0.conditions.0.operator',
      ],
      [
        'a join other than AND or OR',
        (_c, g) => (g.join = 'XOR'),
        'edges.2.data.conditionGroups.0.join',
      ],
      [
        'a condition value that is an object',
        (c) => (c.value = { $ne: '' }),
        'edges.2.data.conditionGroups.0.conditions.0.value',
      ],
      [
        'a condition without a field',
        (c) => delete c.field,
        'edges.2.data.conditionGroups.0.conditions.0.field',
      ],
      [
        'conditionsEnabled that is not a boolean',
        (_c, _g, e) => ((e.data as Doc).conditionsEnabled = 'yes'),
        'edges.2.data.conditionsEnabled',
      ],
      [
        'an edge label that is not text',
        (_c, _g, e) => (e.label = { text: 'Identity' }),
        'edges.2.label',
      ],
    ])('answers %s with 400 naming the field, and stores nothing', async (_name, corrupt, path) => {
      const body = edgeConditionBody();
      const edgeDoc = edge(body, 'core-entra');
      const group = ((edgeDoc.data as Doc).conditionGroups as Doc[])[0];
      corrupt((group.conditions as Doc[])[0], group, edgeDoc);
      const before = JSON.stringify(canvas);

      const res = await save(body);

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(
        expect.arrayContaining([expect.stringMatching(new RegExp(`^${escape(path)}: `))]),
      );
      expect(JSON.stringify(canvas)).toBe(before);
    });
  });

  describe('policy condition and action nodes', () => {
    it('stores them with their edge next to the connector graph, and loads them back', async () => {
      const body = policyNodesBody();
      const policyNodes = (body.nodes as Doc[]).filter((n) =>
        ['condition', 'action'].includes(n.type as string),
      );
      expect(policyNodes.map((n) => n.type)).toEqual(['condition', 'action']);

      const res = await save(body).expect(201);

      expect(res.body).toMatchObject({ success: true, nodeCount: 6, edgeCount: 4 });
      const loaded = (await request(app.getHttpServer()).get('/blueprints/latest').expect(200)).body
        .data;
      expect(loaded.nodes).toEqual(body.nodes);
      expect(loaded.edges).toEqual(body.edges);
      expect((loaded.nodes as Doc[]).slice(-2)).toEqual(policyNodes);
      // The connector graph's flow conditions are stored next to them, as provisioning reads them.
      const stored = await service.getLatestBlueprint();
      expect(stored.edges).toEqual(
        (edgeConditionBody().edges as Doc[]).concat((body.edges as Doc[]).slice(-1)),
      );
    });
  });
});

function correlation(body: Doc): Doc {
  return ((body.connectorConfigs as Record<string, Doc>)['euroid-core'] as Doc)
    .correlationConfig as Doc;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
