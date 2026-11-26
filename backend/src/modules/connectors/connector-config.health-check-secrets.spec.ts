import * as http from 'http';
import type { AddressInfo } from 'net';
import type { ModuleRef } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import { validateUrlForFetch } from '@infrastructure/url-validation/ssrf-guard';
import { SECRET_PLACEHOLDER } from '@infrastructure/secrets/config-secret-mask';
import { ScimActivities } from '../../activities/scim.activities';
import { ConnectorConfigController } from './connector-config.controller';
import { ConnectorConfigService } from './connector-config.service';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { registerBuiltInConnectors } from './plugin/register-connectors';
import { JsonApiHrClient } from './json-api-hr-connector/json-api-hr.client';
import { JsonApiHrService } from './json-api-hr-connector/json-api-hr.service';
import { SCIMClient } from './scim-connector/scim.client';
import { SCIMMapper } from './scim-connector/scim.mapper';
import { SCIMService } from './scim-connector/scim.service';

// The two test servers stand in for public hosts; any other URL gets the real SSRF guard.
jest.mock('@infrastructure/url-validation/ssrf-guard', () => {
  const actual = jest.requireActual('@infrastructure/url-validation/ssrf-guard');
  return { ...actual, validateUrlForFetch: jest.fn(actual.validateUrlForFetch) };
});

type ControllerCtor = ConstructorParameters<typeof ConnectorConfigController>;
type ServiceCtor = ConstructorParameters<typeof ConnectorConfigService>;

const HR_TOKEN = 'stored-hr-token';
const SCIM_TOKEN = 'stored-scim-token';
const SCIM_CLIENT_SECRET = 'stored-scim-client-secret';

/**
 * POST /connectors/:name/health-check with form values, its masked secrets restored from the
 * saved config: the API sends a stored secret only to the saved destination. `saved` is the
 * tenant's HR feed and SCIM server, `attacker` a host of the caller's choosing (the check is open
 * to operator and policy-admin, who cannot read the secrets). Real controller, config service,
 * JSON API HR and SCIM clients, against two HTTP servers.
 */
describe('POST /connectors/:name/health-check: stored secrets go to the saved destination only', () => {
  const hits: Record<'saved' | 'attacker', Array<{ path: string; auth?: string; body: string }>> = {
    saved: [],
    attacker: [],
  };
  const servers: http.Server[] = [];
  const base = { saved: '', attacker: '' };
  let installed: Record<string, Record<string, string>>;
  let controller: ConnectorConfigController;
  const user = { tenantId: 'tenant-a' } as Parameters<ConnectorConfigController['healthCheck']>[2];

  const listen = async (name: 'saved' | 'attacker') => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        hits[name].push({ path: req.url ?? '', auth: req.headers.authorization, body });
        const json = (data: unknown) =>
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        if (req.url?.endsWith('/token')) return json({ access_token: 'issued', expires_in: 3600 });
        if (req.url?.endsWith('/ServiceProviderConfig')) return json({ schemas: [] });
        return json([{ email: 'a@example.com' }]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    base[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    await listen('saved');
    await listen('attacker');
    const actual = jest.requireActual('@infrastructure/url-validation/ssrf-guard');
    (validateUrlForFetch as jest.Mock).mockImplementation((url: string) =>
      url.startsWith(base.saved) || url.startsWith(base.attacker)
        ? Promise.resolve()
        : actual.validateUrlForFetch(url),
    );

    const registry = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(registry);
    const configModel = {
      findOne: (filter: { connectorName: string }) => ({
        exec: async () => {
          const config = installed[filter.connectorName];
          if (!config) return null;
          const doc = {
            connectorName: filter.connectorName,
            configEncrypted: JSON.stringify(config),
          };
          return { ...doc, toObject: () => ({ ...doc }) };
        },
      }),
    };
    const configService = new ConnectorConfigService(
      configModel as unknown as ServiceCtor[0],
      {} as ServiceCtor[1],
      { decrypt: (cipher: string) => cipher } as unknown as ServiceCtor[2],
      {} as ServiceCtor[3],
      registry,
    );
    const tokenCache = new Map<string, unknown>();
    const scimClient = new SCIMClient(
      {
        get: async (key: string) => tokenCache.get(key),
        set: async (key: string, value: unknown) => void tokenCache.set(key, value),
        del: async (key: string) => void tokenCache.delete(key),
      } as unknown as ConstructorParameters<typeof SCIMClient>[0],
      {
        execute: (_name: string, fn: () => Promise<unknown>) => fn(),
      } as unknown as ConstructorParameters<typeof SCIMClient>[1],
    );
    const scim = new ScimActivities(
      new SCIMService(scimClient, new SCIMMapper()),
      {} as never,
      {} as never,
    );
    controller = new ConnectorConfigController(
      configService,
      registry,
      {} as ControllerCtor[2],
      {} as ControllerCtor[3],
      {} as ControllerCtor[4],
      scim,
      {} as ControllerCtor[6],
      {} as ControllerCtor[7],
      new JsonApiHrService(new JsonApiHrClient()),
      {},
    );
  });

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    hits.saved = [];
    hits.attacker = [];
    installed = {
      'json-api-hr': { url: `${base.saved}/users`, authType: 'bearer', bearerToken: HR_TOKEN },
      scim: { baseUrl: `${base.saved}/scim`, authType: 'bearer', bearerToken: SCIM_TOKEN },
    };
  });

  const check = (name: string, config: Record<string, string>) =>
    controller.healthCheck(name, { config }, user);

  it('JSON API HR: a masked token with a changed URL is refused and nothing is sent', async () => {
    const error = await check('json-api-hr', {
      url: `${base.attacker}/collect`,
      authType: 'bearer',
      bearerToken: SECRET_PLACEHOLDER,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      'Type bearerToken again to test a changed url: a stored secret is only sent to the saved ' +
        'destination',
    );
    expect(hits).toEqual({ saved: [], attacker: [] });
  });

  it('JSON API HR: the saved URL gets the stored token', async () => {
    await expect(
      check('json-api-hr', {
        url: `${base.saved}/users`,
        authType: 'bearer',
        bearerToken: SECRET_PLACEHOLDER,
      }),
    ).resolves.toMatchObject({ healthy: true });

    expect(hits.saved).toEqual([{ path: '/users', auth: `Bearer ${HR_TOKEN}`, body: '' }]);
    expect(hits.attacker).toEqual([]);
  });

  it('JSON API HR: a method other than GET is refused before any request', async () => {
    await expect(
      check('json-api-hr', {
        url: `${base.saved}/users`,
        authType: 'bearer',
        bearerToken: SECRET_PLACEHOLDER,
        method: 'PUT',
      }),
    ).rejects.toThrow('The health check reads the feed with GET only: method "PUT" is refused');
    expect(hits).toEqual({ saved: [], attacker: [] });
  });

  it('SCIM: a masked bearer token with a changed base URL is refused and nothing is sent', async () => {
    await expect(
      check('scim', {
        baseUrl: `${base.attacker}/scim`,
        authType: 'bearer',
        bearerToken: SECRET_PLACEHOLDER,
      }),
    ).rejects.toThrow('Type bearerToken again to test a changed baseUrl');
    expect(hits).toEqual({ saved: [], attacker: [] });
  });

  it('SCIM: the saved base URL gets the stored token', async () => {
    await expect(
      check('scim', {
        baseUrl: `${base.saved}/scim`,
        authType: 'bearer',
        bearerToken: SECRET_PLACEHOLDER,
      }),
    ).resolves.toMatchObject({ healthy: true });

    expect(hits.saved).toEqual([
      { path: '/scim/ServiceProviderConfig', auth: `Bearer ${SCIM_TOKEN}`, body: '' },
    ]);
    expect(hits.attacker).toEqual([]);
  });

  it('SCIM OAuth2: a masked client secret with a changed token URL is refused and nothing is sent', async () => {
    installed.scim = {
      baseUrl: `${base.saved}/scim`,
      authType: 'oauth2',
      oauth2TokenUrl: `${base.saved}/token`,
      clientId: 'euroid',
      clientSecret: SCIM_CLIENT_SECRET,
    };

    await expect(
      check('scim', {
        ...installed.scim,
        oauth2TokenUrl: `${base.attacker}/token`,
        clientSecret: SECRET_PLACEHOLDER,
      }),
    ).rejects.toThrow('Type clientSecret again to test a changed oauth2TokenUrl');
    expect(hits).toEqual({ saved: [], attacker: [] });

    // Typed again, the secret goes where the caller says: it is theirs to send
    await check('scim', {
      ...installed.scim,
      oauth2TokenUrl: `${base.attacker}/token`,
      clientSecret: 'typed-now',
    });
    expect(hits.attacker[0].body).toContain('client_secret=typed-now');
    expect(JSON.stringify(hits)).not.toContain(SCIM_CLIENT_SECRET);
  });
});
