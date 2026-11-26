import { BadRequestException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { ConnectorConfigService } from './connector-config.service';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { registerBuiltInConnectors } from './plugin/register-connectors';

type Ctor = ConstructorParameters<typeof ConnectorConfigService>;

const PLACEHOLDER = '••••••••';

/**
 * Masked config keys per built-in connector. Secrets are what each manifest declares
 * `type: 'password'`; a key name merely containing "token" or "secret" is not enough.
 * Adding a connector or a secret field means adding it here.
 */
const MASKED_FIELDS: Record<string, string[]> = {
  ad: ['password'],
  'csv-hr': [],
  'discord-webhook': ['webhookUrl'],
  'entra-id': ['clientSecret'],
  'file-outbound': [],
  github: ['personalAccessToken'],
  'google-sheets': ['serviceAccountJson'],
  'json-api-hr': ['bearerToken', 'authHeaderSecret'],
  okta: ['apiToken'],
  scim: ['bearerToken', 'password', 'clientSecret'],
  servicenow: ['clientSecret', 'password'],
};

function builtInRegistry(): PluginRegistryService {
  const registry = new PluginRegistryService({} as ModuleRef);
  registerBuiltInConnectors(registry);
  return registry;
}

const fakeEncrypt = (plain: string): string => Buffer.from(plain).toString('base64');
const fakeDecrypt = (cipher: string): string => Buffer.from(cipher, 'base64').toString();

/** Service over an in-memory store; the fake cipher is base64 of the JSON config. */
function serviceWith(
  installed: Array<{ connectorName: string; config: Record<string, string> }>,
  registry = builtInRegistry(),
) {
  const docs = installed.map((c) => ({
    connectorName: c.connectorName,
    configEncrypted: fakeEncrypt(JSON.stringify(c.config)),
  }));
  const findOneAndUpdate = jest.fn(
    async (filter: { connectorName: string }, update: { $set: { configEncrypted: string } }) => ({
      connectorName: filter.connectorName,
      ...update.$set,
    }),
  );
  const configModel = {
    find: (filter?: { connectorName?: { $in?: string[] } }) => ({
      lean: () => ({
        exec: async () =>
          docs.filter(
            (d) =>
              !filter?.connectorName?.$in || filter.connectorName.$in.includes(d.connectorName),
          ),
      }),
    }),
    findOne: (filter: { connectorName: string }) => ({
      exec: async () => {
        const doc = docs.find((d) => d.connectorName === filter.connectorName);
        return doc ? { ...doc, toObject: () => ({ ...doc }) } : null;
      },
    }),
    findOneAndUpdate,
  };
  const encryption = {
    decrypt: jest.fn(fakeDecrypt),
    encrypt: jest.fn(fakeEncrypt),
  };
  const auditService = { logFireAndForget: jest.fn() };
  const service = new ConnectorConfigService(
    configModel as unknown as Ctor[0],
    auditService as unknown as Ctor[1],
    encryption as unknown as Ctor[2],
    {} as Ctor[3],
    registry,
  );
  const savedConfig = (): Record<string, string> =>
    JSON.parse(fakeDecrypt(findOneAndUpdate.mock.calls[0][1].$set.configEncrypted)) as Record<
      string,
      string
    >;
  return { service, encryption, savedConfig };
}

describe('ConnectorConfigService secret redaction', () => {
  it('pins a masked-field list for every registered connector', () => {
    const ids = builtInRegistry()
      .getAll()
      .map((m) => m.id)
      .sort();
    expect(Object.keys(MASKED_FIELDS).sort()).toEqual(ids);
  });

  it.each(Object.entries(MASKED_FIELDS))(
    'GET /connectors masks exactly %s fields %j',
    async (id, expectedMasked) => {
      const registry = builtInRegistry();
      const keys = registry.getConfigSchema(id).map((f) => f.key);
      const config = Object.fromEntries(keys.map((k) => [k, `value-of-${k}`]));
      const { service } = serviceWith([{ connectorName: id, config }], registry);

      const [listed] = await service.listInstalled();

      const masked = keys.filter((k) => listed.config[k] === PLACEHOLDER);
      expect(masked).toEqual(expectedMasked);
      for (const k of keys.filter((key) => !expectedMasked.includes(key))) {
        expect(listed.config[k]).toBe(`value-of-${k}`);
      }
    },
  );

  it('leaves the configEncrypted ciphertext out of GET /connectors', async () => {
    const config = { tenantId: 'azure-tenant', clientId: 'app-1', clientSecret: 's3cret' };
    const { service } = serviceWith([{ connectorName: 'entra-id', config }]);

    const [listed] = await service.listInstalled();

    expect(listed).not.toHaveProperty('configEncrypted');
    expect(listed.connectorName).toBe('entra-id');
    const body = JSON.stringify(listed);
    expect(body).not.toContain(fakeEncrypt(JSON.stringify(config)));
    expect(body).not.toContain('s3cret');
  });

  it('returns the SCIM OAuth2 token URL in clear (not a secret despite "token" in its name)', async () => {
    const { service } = serviceWith([
      {
        connectorName: 'scim',
        config: { oauth2TokenUrl: 'https://auth.example.com/oauth/token', clientSecret: 's-1' },
      },
    ]);

    const [listed] = await service.listInstalled();

    expect(listed.config).toEqual({
      oauth2TokenUrl: 'https://auth.example.com/oauth/token',
      clientSecret: PLACEHOLDER,
    });
  });

  it('masks the Discord webhook URL, which embeds the webhook token', async () => {
    const { service } = serviceWith([
      {
        connectorName: 'discord-webhook',
        config: { webhookUrl: 'https://discord.com/api/webhooks/123/tok-abc' },
      },
    ]);

    const [listed] = await service.listInstalled();

    expect(listed.config.webhookUrl).toBe(PLACEHOLDER);
    expect(JSON.stringify(listed)).not.toContain('tok-abc');
  });

  it('redacts the JSON API HR credentials and keeps the non-secret auth settings', async () => {
    const stored = {
      url: 'https://hr.example.com/api/users',
      authType: 'header',
      authHeaderName: 'X-API-Key',
      authHeaderSecret: 'k-123',
      bearerToken: 'tok-456',
    };
    const { service, encryption } = serviceWith([{ connectorName: 'json-api-hr', config: stored }]);

    const [listed] = await service.listInstalled();

    expect(encryption.decrypt).toHaveBeenCalledWith(fakeEncrypt(JSON.stringify(stored)));
    expect(listed.config).toEqual({
      url: 'https://hr.example.com/api/users',
      authType: 'header',
      authHeaderName: 'X-API-Key',
      authHeaderSecret: PLACEHOLDER,
      bearerToken: PLACEHOLDER,
    });
  });

  it('masks every key of a connector that has no registered manifest', async () => {
    const { service } = serviceWith([
      { connectorName: 'unknown-connector', config: { endpoint: 'https://x.example', mode: 'a' } },
    ]);

    const [listed] = await service.listInstalled();

    expect(listed.config).toEqual({ endpoint: PLACEHOLDER, mode: PLACEHOLDER });
  });
});

describe('ConnectorConfigService.updateConfig secret merge', () => {
  it('keeps the stored Discord webhook URL when the mask is sent back', async () => {
    const webhookUrl = 'https://discord.com/api/webhooks/123/tok-abc';
    const { service, savedConfig } = serviceWith([
      { connectorName: 'discord-webhook', config: { webhookUrl } },
    ]);

    await service.updateConfig('discord-webhook', { webhookUrl: PLACEHOLDER });

    expect(savedConfig()).toEqual({ webhookUrl });
  });

  it('saves a new SCIM OAuth2 token URL and keeps the masked client secret', async () => {
    const { service, savedConfig } = serviceWith([
      {
        connectorName: 'scim',
        config: { oauth2TokenUrl: 'https://old.example.com/token', clientSecret: 's-1' },
      },
    ]);

    await service.updateConfig('scim', {
      oauth2TokenUrl: 'https://new.example.com/token',
      clientSecret: PLACEHOLDER,
    });

    expect(savedConfig()).toEqual({
      oauth2TokenUrl: 'https://new.example.com/token',
      clientSecret: 's-1',
    });
  });
});

// A health check runs on the form's values, where a secret the user did not retype is the mask.
// A stored secret is restored only for the saved destination (where, and as whom, it is sent):
// otherwise any caller of the health check could have the API send it to a host of their own.
describe('ConnectorConfigService.withStoredSecrets (health check config)', () => {
  it('replaces a masked secret with the stored value and keeps the other form values', async () => {
    const { service } = serviceWith([
      {
        connectorName: 'json-api-hr',
        config: { url: 'https://hr.example.com/users', bearerToken: 'stored-token' },
      },
    ]);

    const config = await service.withStoredSecrets('json-api-hr', {
      url: 'https://hr.example.com/users',
      authType: 'bearer',
      bearerToken: PLACEHOLDER,
      responsePath: 'data',
    });

    expect(config).toEqual({
      url: 'https://hr.example.com/users',
      authType: 'bearer',
      bearerToken: 'stored-token',
      responsePath: 'data',
    });
  });

  it.each<[string, Record<string, string>, Record<string, string>, string]>([
    [
      'okta',
      { orgUrl: 'https://acme.okta.com', apiToken: 'ssws-1' },
      { orgUrl: 'https://attacker.example', apiToken: PLACEHOLDER },
      'orgUrl',
    ],
    [
      'json-api-hr',
      { url: 'https://hr.example.com/users', authHeaderSecret: 'k-1', authHeaderName: 'X-Key' },
      { url: 'https://attacker.example/x', authHeaderSecret: PLACEHOLDER, authHeaderName: 'X-Key' },
      'url',
    ],
    [
      'scim',
      { baseUrl: 'https://scim.example.com', bearerToken: 'scim-1' },
      { baseUrl: 'https://attacker.example', bearerToken: PLACEHOLDER },
      'baseUrl',
    ],
    [
      'scim',
      {
        baseUrl: 'https://scim.example.com',
        oauth2TokenUrl: 'https://idp.example.com/token',
        clientId: 'c-1',
        clientSecret: 's-1',
      },
      {
        baseUrl: 'https://scim.example.com',
        oauth2TokenUrl: 'https://attacker.example/token',
        clientId: 'c-1',
        clientSecret: PLACEHOLDER,
      },
      'oauth2TokenUrl',
    ],
    [
      'ad',
      { host: 'dc01.corp.example', serviceAccount: 'CN=svc', password: 'p-1' },
      { host: 'attacker.example', serviceAccount: 'CN=svc', password: PLACEHOLDER },
      'host',
    ],
    [
      'ad',
      { host: 'dc01.corp.example', useLdaps: 'true', serviceAccount: 'CN=svc', password: 'p-1' },
      {
        host: 'dc01.corp.example',
        useLdaps: 'false',
        serviceAccount: 'CN=svc',
        password: PLACEHOLDER,
      },
      'useLdaps',
    ],
    [
      'ad',
      { host: 'dc01.corp.example', port: '636', serviceAccount: 'CN=svc', password: 'p-1' },
      { host: 'dc01.corp.example', serviceAccount: 'CN=svc', password: PLACEHOLDER },
      'port',
    ],
    [
      'entra-id',
      { tenantId: 't-1', clientId: 'c-1', clientSecret: 's-1' },
      { tenantId: 't-2', clientId: 'c-1', clientSecret: PLACEHOLDER },
      'tenantId',
    ],
  ])(
    '%s: refuses a masked secret when the destination changed (%#), and names the field',
    async (name, stored, sent, field) => {
      const { service } = serviceWith([{ connectorName: name, config: stored }]);

      const error = await service.withStoredSecrets(name, sent).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain(field);
      expect((error as Error).message).toMatch(/type .* again/i);
      expect(JSON.stringify((error as BadRequestException).getResponse())).not.toMatch(
        /ssws-1|k-1|scim-1|s-1|p-1/,
      );
    },
  );

  it('uses a secret typed again with a changed destination as sent', async () => {
    const { service } = serviceWith([
      { connectorName: 'okta', config: { orgUrl: 'https://acme.okta.com', apiToken: 'ssws-1' } },
    ]);

    const config = await service.withStoredSecrets('okta', {
      orgUrl: 'https://other.okta.com',
      apiToken: 'typed-now',
    });

    expect(config).toEqual({ orgUrl: 'https://other.okta.com', apiToken: 'typed-now' });
  });

  it('takes a number or boolean the form sends as the saved text', async () => {
    const { service } = serviceWith([
      {
        connectorName: 'ad',
        config: {
          host: 'dc01',
          port: '636',
          useLdaps: 'true',
          serviceAccount: 'CN=svc',
          password: 'p-1',
        },
      },
    ]);

    const config = await service.withStoredSecrets('ad', {
      host: 'dc01',
      port: 636 as unknown as string,
      useLdaps: true as unknown as string,
      serviceAccount: 'CN=svc',
      password: PLACEHOLDER,
    });

    expect(config.password).toBe('p-1');
  });

  it('uses a retyped secret as sent and leaves a non-secret placeholder-like value alone', async () => {
    const { service } = serviceWith([
      { connectorName: 'scim', config: { bearerToken: 'stored', oauth2TokenUrl: 'u' } },
    ]);

    const config = await service.withStoredSecrets('scim', {
      bearerToken: 'typed-now',
      oauth2TokenUrl: PLACEHOLDER,
    });

    expect(config).toEqual({ bearerToken: 'typed-now', oauth2TokenUrl: PLACEHOLDER });
  });

  it('drops a masked secret when nothing is stored, so the mask is never used as a credential', async () => {
    const { service } = serviceWith([]);

    const config = await service.withStoredSecrets('entra-id', {
      tenantId: 't-1',
      clientSecret: PLACEHOLDER,
    });

    expect(config).toEqual({ tenantId: 't-1' });
  });
});

describe('ConnectorConfigService.isHrSourceName', () => {
  it.each(['csv-hr', 'json-api-hr'])(
    'recognises the source name of the built-in HR connector %s',
    async (name) => {
      expect(await serviceWith([]).service.isHrSourceName(name)).toBe(true);
    },
  );

  it.each(['entra-id', 'ad', 'okta', 'scim', 'file-outbound', 'manual-ui'])(
    'does not take %s (a target or no connector) for an HR source',
    async (name) => {
      expect(await serviceWith([]).service.isHrSourceName(name)).toBe(false);
    },
  );

  it('recognises the sourceSystem an installed HR connector is configured with', async () => {
    const { service } = serviceWith([
      { connectorName: 'csv-hr', config: { filePath: 'x.csv', sourceSystem: 'Workday Export' } },
    ]);

    expect(await service.isHrSourceName('workday-export')).toBe(true);
    expect(await service.isHrSourceName('workday')).toBe(false);
  });

  it('ignores a sourceSystem key in the config of a target connector', async () => {
    const { service } = serviceWith([
      { connectorName: 'file-outbound', config: { sourceSystem: 'payroll' } },
    ]);

    expect(await service.isHrSourceName('payroll')).toBe(false);
  });
});
