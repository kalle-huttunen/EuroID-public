/**
 * Connector Contract Tests
 *
 * The IConnector contract (connector.interface.ts) run against real connectors, each on the
 * config its tenant installed (ConnectorConfigService mocked), as create() and healthCheck()
 * read it without one:
 * - File Outbound on a temporary directory;
 * - Okta against a mocked Okta API (axios mocked) that keeps the users it was sent.
 *
 * create() answers the account id it made. A connector whose create is idempotent answers the
 * same account for the same user (Okta: a 409 updates the existing user, Safety Rule 7). File
 * Outbound is append-only by its manifest (the same user twice is two lines): its repeat is
 * pinned in file-outbound.service.spec.ts.
 */
import axios from 'axios';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import { IConnector } from './connector.interface';
import type { ConnectorConfigService } from './connector-config.service';
import { FileOutboundService } from './file-outbound-connector/file-outbound.service';
import { OktaService } from './okta-connector/okta.service';
import { OktaClient } from './okta-connector/okta.client';
import { OktaMapper } from './okta-connector/okta.mapper';
import { OktaDiscoveryService } from './okta-connector/okta-discovery.service';
import { OktaProvisioningService } from './okta-connector/okta-provisioning.service';
import { createMockUser } from '@testing/mock-factories';
import { fakeHttp, httpError, type FakeHttpCall } from '@testing/fake-http';

jest.mock('axios');

type Entitlement = { nativeId: string; name: string; type: string };

interface ContractClaims {
  /** create() twice for the same user answers the same account */
  idempotentCreate: boolean;
  /** What discover() answers, for a connector that discovers */
  entitlements?: Entitlement[];
}

const installed = (config: Record<string, unknown>) =>
  ({ getConfig: jest.fn().mockResolvedValue({ config }) }) as unknown as ConnectorConfigService;

const idOf = (result: { targetUserId: string } | string) =>
  typeof result === 'string' ? result : result.targetUserId;

/**
 * Generic contract test harness: run against any IConnector implementation. The idempotency and
 * discovery cases run for a connector that claims them.
 */
function runConnectorContractTests(
  name: string,
  claims: ContractClaims,
  factory: () => IConnector | Promise<IConnector>,
) {
  describe(`IConnector contract: ${name}`, () => {
    let connector: IConnector;

    beforeAll(async () => {
      connector = await factory();
    });

    it('is healthy with the config its tenant installed', async () => {
      await expect(connector.healthCheck()).resolves.toBe(true);
    });

    it('create answers the id of the account it made', async () => {
      const result = await connector.create(createMockUser({ email: 'contract-test@example.com' }));
      expect(idOf(result)).toEqual(expect.any(String));
      expect(idOf(result).length).toBeGreaterThan(0);
    });

    if (claims.idempotentCreate) {
      it('create is idempotent: the same user twice answers the same account', async () => {
        const user = createMockUser({ email: 'idempotent@example.com' });
        const first = idOf(await connector.create(user));
        const second = idOf(await connector.create(user));
        expect(second).toBe(first);
      });
    }

    const { entitlements } = claims;
    if (entitlements) {
      it('discover answers the entitlements of the target', async () => {
        await expect(connector.discover!()).resolves.toEqual(
          entitlements.map((e) => expect.objectContaining(e)),
        );
      });
    }
  });
}

describe('Connector Contract Tests', () => {
  let tempDir: string;

  const allowedDirBefore = process.env.FILE_OUTBOUND_ALLOWED_DIR;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-contract-'));
    // File outbound writes only inside its allowed directory (file-outbound.service.ts)
    process.env.FILE_OUTBOUND_ALLOWED_DIR = tempDir;
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (allowedDirBefore === undefined) delete process.env.FILE_OUTBOUND_ALLOWED_DIR;
    else process.env.FILE_OUTBOUND_ALLOWED_DIR = allowedDirBefore;
  });

  runConnectorContractTests(
    'File Outbound',
    { idempotentCreate: false },
    () =>
      new FileOutboundService(
        installed({ outputFilePath: path.join(tempDir, 'provisioning-log.jsonl') }),
      ),
  );

  runConnectorContractTests(
    'Okta',
    {
      idempotentCreate: true,
      entitlements: [
        { nativeId: '00g1', name: 'Engineers', type: 'Group' },
        { nativeId: '0oa1', name: 'Slack', type: 'Application' },
      ],
    },
    () => {
      // The Okta org: users by login; creating a login it already has is a 409
      const users = new Map<string, { id: string; profile: Record<string, unknown> }>();
      const api = fakeHttp(({ method, url, data }: FakeHttpCall) => {
        if (method === 'GET' && url === '/org') return { id: '00o1' };
        if (method === 'GET' && url === '/groups?limit=200') {
          return [{ id: '00g1', profile: { name: 'Engineers' } }];
        }
        if (method === 'GET' && url === '/apps?limit=200') {
          return [{ id: '0oa1', name: 'slack', label: 'Slack' }];
        }
        if (method === 'POST' && url.startsWith('/users?activate=')) {
          const profile = (data as { profile: Record<string, unknown> }).profile;
          const login = String(profile.login);
          if (users.has(login)) throw httpError(409, {}, { errorCode: 'E0000001' });
          const user = { id: `00u${users.size + 1}`, status: 'ACTIVE', profile };
          users.set(login, user);
          return user;
        }
        const byLogin = [...users.values()].find(
          (u) => url === `/users/${encodeURIComponent(String(u.profile.login))}`,
        );
        if (method === 'GET' && byLogin) return byLogin;
        const byId = [...users.values()].find((u) => url === `/users/${u.id}`);
        if (method === 'POST' && byId) return byId;
        throw httpError(404);
      });
      (axios.create as jest.Mock).mockReturnValue(api.instance);
      const client = new OktaClient();
      return new OktaService(
        new OktaDiscoveryService(client),
        new OktaProvisioningService(client, new OktaMapper()),
        installed({ orgUrl: 'https://acme.okta.example', apiToken: 'ssws-test' }),
        { get: jest.fn() } as unknown as ConfigService,
      );
    },
  );
});
