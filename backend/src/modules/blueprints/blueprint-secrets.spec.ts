/**
 * Blueprint responses never carry a connector secret (any role can read GET /blueprints/latest
 * and GET /blueprints/:id), and the Design studio's save of a masked config keeps the stored
 * secret. Runs the service and controller over an in-memory store with the real connector
 * registry, so the secrets are what the manifests declare.
 */

import type { ModuleRef } from '@nestjs/core';
import { BlueprintsService } from './blueprints.service';
import { BlueprintsController } from './blueprints.controller';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../connectors/plugin/register-connectors';
import { SECRET_PLACEHOLDER } from '@infrastructure/secrets/config-secret-mask';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'tenant-a' }),
}));

type ServiceCtor = ConstructorParameters<typeof BlueprintsService>;
type ControllerCtor = ConstructorParameters<typeof BlueprintsController>;
type Doc = Record<string, unknown>;

const ENC = 'enc:';
const encryption = {
  encrypt: (plain: string) => ENC + Buffer.from(plain).toString('base64'),
  decrypt: (cipher: string) => Buffer.from(cipher.slice(ENC.length), 'base64').toString(),
  isEncrypted: (value: string) => value.startsWith(ENC),
};

const SECRETS = {
  entraTyped: 'entra-client-secret-1',
  entraUntyped: 'entra-client-secret-2',
  discord: 'https://discord.com/api/webhooks/1/webhook-token',
  scimBearer: 'scim-bearer-1',
  okta: 'ssws-okta-1',
  github: 'ghp_github_1',
};

const withToObject = (doc: Doc) => ({ ...doc, toObject: () => ({ ...doc }) });

function setup() {
  const registry = new PluginRegistryService({} as ModuleRef);
  registerBuiltInConnectors(registry);
  let canvas: Doc | null = null;
  const nodeDocs = new Map<string, Doc>();
  const canvasModel = {
    findOne: jest.fn(async () => (canvas ? withToObject(canvas) : null)),
    findOneAndUpdate: jest.fn(async (_filter: unknown, update: { $set: Doc }) => {
      canvas = { ...canvas, ...update.$set, _id: 'canvas-1', updatedAt: new Date() };
      return withToObject(canvas);
    }),
  };
  const blueprintModel = {
    findOne: jest.fn(async (filter: { nodeId: string }) => {
      const doc = nodeDocs.get(filter.nodeId);
      return doc ? withToObject(doc) : null;
    }),
    findOneAndUpdate: jest.fn(async (filter: { nodeId: string }, update: { $set: Doc }) => {
      const doc = { ...nodeDocs.get(filter.nodeId), nodeId: filter.nodeId, ...update.$set };
      nodeDocs.set(filter.nodeId, doc);
      return withToObject(doc);
    }),
  };
  const service = new BlueprintsService(
    blueprintModel as unknown as ServiceCtor[0],
    canvasModel as unknown as ServiceCtor[1],
    { logFireAndForget: jest.fn() } as unknown as ServiceCtor[2],
    encryption as unknown as ServiceCtor[3],
    registry,
  );
  const controller = new BlueprintsController(
    service,
    {} as ControllerCtor[1],
    {} as ControllerCtor[2],
    // The contract-critical mastery check of the save passes (contract-critical-mastery tests)
    { assertCanvasMastery: async () => undefined } as unknown as ControllerCtor[3],
    {} as ControllerCtor[4],
    { DEFAULT_TENANT_ID: 'tenant-a' } as ControllerCtor[5],
  );
  return { service, controller, storedCanvas: () => canvas, nodeDocs };
}

/** A canvas as the Design studio saves it, with every secret in clear. */
function canvasWithSecrets() {
  return {
    nodes: [
      {
        id: 'entra-id-target-1',
        position: { x: 0, y: 0 },
        data: {
          role: 'target',
          type: 'entra-id',
          config: { tenantId: 'tid-1', clientId: 'cid-1', clientSecret: SECRETS.entraTyped },
        },
      },
      // The default canvas's Entra node names no connector (no data.type).
      {
        id: 'entra-target',
        position: { x: 0, y: 0 },
        data: {
          role: 'target',
          config: { tenantId: 'tid-2', clientSecret: SECRETS.entraUntyped },
        },
      },
      {
        id: 'discord-webhook-target-1',
        position: { x: 0, y: 0 },
        data: { role: 'target', type: 'discord-webhook', config: { webhookUrl: SECRETS.discord } },
      },
      {
        id: 'scim-target-1',
        position: { x: 0, y: 0 },
        data: {
          role: 'target',
          type: 'scim',
          config: {
            baseUrl: 'https://scim.example',
            oauth2TokenUrl: 'https://auth.example/token',
            bearerToken: SECRETS.scimBearer,
          },
        },
      },
      {
        id: 'csv-hr-source',
        position: { x: 0, y: 0 },
        data: {
          role: 'source',
          type: 'csv-hr',
          config: { filePath: '/data/hr.csv', ingestPriority: 1 },
        },
      },
    ],
    edges: [],
    connectorConfigs: {
      okta: { orgUrl: 'https://dev.okta.com', apiToken: SECRETS.okta },
      'euroid-core': { correlationConfig: { rules: [{ strategy: 'email' }] } },
    },
  };
}

const containsAnySecret = (value: unknown) =>
  Object.values(SECRETS).some((secret) => JSON.stringify(value).includes(secret));

type LatestResponse = {
  data: {
    nodes: Array<{ id: string; data: { config: Record<string, unknown> } }>;
    connectorConfigs: Record<string, Record<string, unknown>>;
  };
};
const configOf = (res: LatestResponse, nodeId: string) =>
  res.data.nodes.find((n) => n.id === nodeId)!.data.config;

describe('Blueprint responses mask connector secrets', () => {
  it('GET /blueprints/latest returns every declared secret masked and the rest in clear', async () => {
    const { service, controller } = setup();
    await service.saveBlueprint(canvasWithSecrets());

    const res = (await controller.getLatestCanvas()) as unknown as LatestResponse;

    expect(containsAnySecret(res)).toBe(false);
    expect(configOf(res, 'entra-id-target-1')).toEqual({
      tenantId: 'tid-1',
      clientId: 'cid-1',
      clientSecret: SECRET_PLACEHOLDER,
    });
    // No data.type: a key some connector declares secret is masked, the tenant id is not.
    expect(configOf(res, 'entra-target')).toEqual({
      tenantId: 'tid-2',
      clientSecret: SECRET_PLACEHOLDER,
    });
    expect(configOf(res, 'discord-webhook-target-1')).toEqual({ webhookUrl: SECRET_PLACEHOLDER });
    expect(configOf(res, 'scim-target-1')).toEqual({
      baseUrl: 'https://scim.example',
      oauth2TokenUrl: 'https://auth.example/token',
      bearerToken: SECRET_PLACEHOLDER,
    });
    expect(configOf(res, 'csv-hr-source')).toEqual({ filePath: '/data/hr.csv', ingestPriority: 1 });
    expect(res.data.connectorConfigs.okta).toEqual({
      orgUrl: 'https://dev.okta.com',
      apiToken: SECRET_PLACEHOLDER,
    });
    // The brain's correlation settings are no secret; the Design studio form needs them.
    expect(res.data.connectorConfigs['euroid-core']).toEqual({
      correlationConfig: { rules: [{ strategy: 'email' }] },
    });
  });

  it('keeps the decrypted secrets for server-side use (workers, health checks)', async () => {
    const { service } = setup();
    await service.saveBlueprint(canvasWithSecrets());

    const canvas = await service.getLatestBlueprint();

    expect(containsAnySecret(canvas)).toBe(true);
  });

  it('GET /blueprints/:id masks a node config, from a node document or from the canvas', async () => {
    const { service, controller } = setup();
    await service.saveBlueprint(canvasWithSecrets());
    await service.updateNodeConfig('github-target-1', {
      nodeType: 'github',
      config: { orgName: 'acme', personalAccessToken: SECRETS.github },
    });

    const fromDoc = await controller.findOne('github-target-1');
    const fromCanvas = await controller.findOne('discord-webhook-target-1');

    expect(containsAnySecret([fromDoc, fromCanvas])).toBe(false);
    expect(fromDoc?.config).toEqual({ orgName: 'acme', personalAccessToken: SECRET_PLACEHOLDER });
    expect(fromCanvas?.config).toEqual({ webhookUrl: SECRET_PLACEHOLDER });
  });

  it('PATCH /blueprints/:id answers with the secret masked', async () => {
    const { controller } = setup();

    const res = await controller.update('github-target-1', {
      nodeType: 'github',
      config: { orgName: 'acme', personalAccessToken: SECRETS.github },
    });

    expect(containsAnySecret(res)).toBe(false);
    expect(res?.config).toEqual({ orgName: 'acme', personalAccessToken: SECRET_PLACEHOLDER });
  });
});

describe('Saving a masked blueprint keeps the stored secrets', () => {
  it('a canvas saved back as GET returned it, with one field edited, keeps every secret', async () => {
    const { service, controller } = setup();
    await service.saveBlueprint(canvasWithSecrets());
    const loaded = (await controller.getLatestCanvas()) as unknown as LatestResponse;
    configOf(loaded, 'entra-id-target-1').clientId = 'cid-edited';

    await controller.saveCanvas({ nodes: loaded.data.nodes, edges: [] });

    const stored = await service.getLatestBlueprint();
    const storedConfig = (id: string) =>
      (stored.nodes as Array<{ id: string; data: { config: Doc } }>).find((n) => n.id === id)!.data
        .config;
    expect(storedConfig('entra-id-target-1')).toEqual({
      tenantId: 'tid-1',
      clientId: 'cid-edited',
      clientSecret: SECRETS.entraTyped,
    });
    expect(storedConfig('entra-target').clientSecret).toBe(SECRETS.entraUntyped);
    expect(storedConfig('discord-webhook-target-1')).toEqual({ webhookUrl: SECRETS.discord });
    expect(storedConfig('scim-target-1').bearerToken).toBe(SECRETS.scimBearer);
  });

  it('a masked connectorConfigs entry keeps its stored secret', async () => {
    const { service, controller } = setup();
    await service.saveBlueprint(canvasWithSecrets());
    const loaded = (await controller.getLatestCanvas()) as unknown as LatestResponse;

    await controller.saveCanvas({
      nodes: [],
      edges: [],
      connectorConfigs: { okta: loaded.data.connectorConfigs.okta },
    });

    const stored = await service.getLatestBlueprint();
    expect(stored.connectorConfigs).toEqual({
      okta: { orgUrl: 'https://dev.okta.com', apiToken: SECRETS.okta },
    });
  });

  it('a new value replaces the secret, an emptied one removes it, and the mask is never stored', async () => {
    const { service, storedCanvas } = setup();
    await service.saveBlueprint(canvasWithSecrets());

    await service.saveBlueprint({
      nodes: [
        {
          id: 'entra-id-target-1',
          data: { type: 'entra-id', config: { tenantId: 'tid-1', clientSecret: 'rotated' } },
        },
        {
          id: 'discord-webhook-target-1',
          data: { type: 'discord-webhook', config: { webhookUrl: '' } },
        },
        // A node the stored canvas does not have: nothing to keep.
        {
          id: 'okta-target-9',
          data: { type: 'okta', config: { orgUrl: 'o', apiToken: SECRET_PLACEHOLDER } },
        },
      ],
      edges: [],
    });

    const stored = await service.getLatestBlueprint();
    const configs = Object.fromEntries(
      (stored.nodes as Array<{ id: string; data: { config: Doc } }>).map((n) => [
        n.id,
        n.data.config,
      ]),
    );
    expect(configs['entra-id-target-1']).toEqual({ tenantId: 'tid-1', clientSecret: 'rotated' });
    expect(configs['discord-webhook-target-1']).toEqual({});
    expect(configs['okta-target-9']).toEqual({ orgUrl: 'o' });
    expect(JSON.stringify(storedCanvas())).not.toContain(SECRET_PLACEHOLDER);
  });

  it('PATCH with the mask keeps the node document secret', async () => {
    const { service, controller, nodeDocs } = setup();
    await service.updateNodeConfig('github-target-1', {
      nodeType: 'github',
      config: { orgName: 'acme', personalAccessToken: SECRETS.github },
    });

    await controller.update('github-target-1', {
      nodeType: 'github',
      config: { orgName: 'acme-renamed', personalAccessToken: SECRET_PLACEHOLDER },
    });

    const node = await service.getNodeConfig('github-target-1');
    expect(node?.config).toEqual({ orgName: 'acme-renamed', personalAccessToken: SECRETS.github });
    expect(JSON.stringify([...nodeDocs.values()])).not.toContain(SECRET_PLACEHOLDER);
  });
});
