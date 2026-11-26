/**
 * Design studio configs are encrypted at rest when they hold a secret that the connector's
 * manifest declares (type: 'password'), not when a key merely looks like one. A config of a
 * node that names no registered connector is encrypted whole.
 */

import type { ModuleRef } from '@nestjs/core';
import { BlueprintsService } from './blueprints.service';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../connectors/plugin/register-connectors';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'tenant-a' }),
}));

type Ctor = ConstructorParameters<typeof BlueprintsService>;

const ENC = 'enc:';
const encryption = {
  encrypt: (plain: string) => ENC + Buffer.from(plain).toString('base64'),
  decrypt: (cipher: string) => Buffer.from(cipher.slice(ENC.length), 'base64').toString(),
  isEncrypted: (value: string) => value.startsWith(ENC),
};

function setup() {
  const registry = new PluginRegistryService({} as ModuleRef);
  registerBuiltInConnectors(registry);
  const blueprintModel = {
    findOneAndUpdate: jest.fn(async (_filter: unknown, update: { $set: object }) => ({
      ...update.$set,
      toObject() {
        return { ...update.$set };
      },
    })),
  };
  const canvasModel = {
    findOne: jest.fn(async () => null),
    findOneAndUpdate: jest.fn(async () => ({ _id: 'canvas-1' })),
  };
  const service = new BlueprintsService(
    blueprintModel as unknown as Ctor[0],
    canvasModel as unknown as Ctor[1],
    { logFireAndForget: jest.fn() } as unknown as Ctor[2],
    encryption as unknown as Ctor[3],
    registry,
  );
  const savedCanvas = () =>
    (canvasModel.findOneAndUpdate.mock.calls[0] as unknown[])[1] as {
      $set: {
        nodes: Array<{ id: string; data: { config: unknown } }>;
        connectorConfigs: Record<string, unknown>;
      };
    };
  return { service, blueprintModel, savedCanvas };
}

const isCipher = (value: unknown) => typeof value === 'string' && value.startsWith(ENC);

describe('BlueprintsService config encryption at rest', () => {
  it('encrypts node configs by the connector declaration, not by key name', async () => {
    const { service, savedCanvas } = setup();

    await service.saveBlueprint({
      nodes: [
        {
          id: 'discord-target-1',
          data: {
            type: 'discord-webhook',
            config: { webhookUrl: 'https://discord.com/api/webhooks/1/tok' },
          },
        },
        {
          id: 'scim-target-1',
          data: {
            type: 'scim',
            config: { baseUrl: 'https://scim.example', oauth2TokenUrl: 'https://auth.example' },
          },
        },
        { id: 'entra-target-1', data: { type: 'entra-id', config: { clientSecret: 's3cret' } } },
        { id: 'euroid-core', data: { config: { correlationConfig: { rules: [] } } } },
      ],
      edges: [],
    });

    const [discord, scim, entra, core] = savedCanvas().$set.nodes;
    // webhookUrl embeds the webhook token; the old key-name match stored it in clear.
    expect(isCipher(discord.data.config)).toBe(true);
    // No declared secret: oauth2TokenUrl stays readable despite "token" in its name.
    expect(scim.data.config).toEqual({
      baseUrl: 'https://scim.example',
      oauth2TokenUrl: 'https://auth.example',
    });
    expect(isCipher(entra.data.config)).toBe(true);
    // No registered connector: encrypted whole.
    expect(isCipher(core.data.config)).toBe(true);
  });

  it('encrypts connectorConfigs entries by the connector their key names', async () => {
    const { service, savedCanvas } = setup();

    await service.saveBlueprint({
      nodes: [],
      edges: [],
      connectorConfigs: {
        'csv-hr': { filePath: '/data/hr.csv', sourceSystem: 'csv-hr' },
        okta: { orgUrl: 'https://dev.okta.com', apiToken: 'ssws-1' },
        'euroid-core': { correlationConfig: { rules: [] } },
      },
    });

    const configs = savedCanvas().$set.connectorConfigs;
    expect(configs['csv-hr']).toEqual({ filePath: '/data/hr.csv', sourceSystem: 'csv-hr' });
    expect(isCipher(configs.okta)).toBe(true);
    expect(isCipher(configs['euroid-core'])).toBe(true);
  });

  it('encrypts a node config update by its nodeType, and whole when none is given', async () => {
    const { service, blueprintModel } = setup();
    const storedConfig = (call: number) =>
      (blueprintModel.findOneAndUpdate.mock.calls[call] as unknown[])[1] as {
        $set: { config: unknown };
      };

    await service.updateNodeConfig('n1', { nodeType: 'github', config: { owner: 'acme' } });
    await service.updateNodeConfig('n2', {
      nodeType: 'github',
      config: { owner: 'acme', personalAccessToken: 'ghp_1' },
    });
    await service.updateNodeConfig('n3', { config: { owner: 'acme' } });

    expect(storedConfig(0).$set.config).toEqual({ owner: 'acme' });
    expect(isCipher(storedConfig(1).$set.config)).toBe(true);
    expect(isCipher(storedConfig(2).$set.config)).toBe(true);
  });
});
