/**
 * GET /blueprints/latest when the saved canvas cannot be loaded. Any load error was logged and
 * answered `success: true` with an empty canvas: the Design studio showed its default layout as
 * the saved one, and a Save overwrote the stored canvas (browser check of 2026-11-24 with another
 * ENCRYPTION_KEY). It is now 503 with a message that says what to check, as a connector config
 * this process cannot decrypt is, and the stored canvas is left unchanged.
 */

import { HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { BlueprintsService } from './blueprints.service';
import { BlueprintsController } from './blueprints.controller';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../connectors/plugin/register-connectors';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'tenant-a' }),
}));

type ServiceCtor = ConstructorParameters<typeof BlueprintsService>;
type ControllerCtor = ConstructorParameters<typeof BlueprintsController>;

const ENC = 'enc:';
/** Another process's key: the stored ciphertext is recognised but cannot be decrypted. */
const otherKey = {
  encrypt: (plain: string) => ENC + Buffer.from(plain).toString('base64'),
  decrypt: () => {
    throw new Error('Unsupported state or unable to authenticate data');
  },
  isEncrypted: (value: string) => value.startsWith(ENC),
};

/** The saved canvas: one node, and the Brain's correlation settings stored encrypted. */
const STORED = {
  _id: 'canvas-1',
  version: 'draft',
  tenantId: 'tenant-a',
  nodes: [{ id: 'csv-hr-source', position: { x: 0, y: 0 }, data: { role: 'source' } }],
  edges: [],
  connectorConfigs: { 'euroid-core': `${ENC}c2VjcmV0` },
  updatedAt: new Date('2026-11-24T08:00:00Z'),
};

function setup(findOne: () => Promise<unknown>) {
  const registry = new PluginRegistryService({} as ModuleRef);
  registerBuiltInConnectors(registry);
  const canvasModel = { findOne: jest.fn(findOne), findOneAndUpdate: jest.fn() };
  const service = new BlueprintsService(
    {} as ServiceCtor[0],
    canvasModel as unknown as ServiceCtor[1],
    { logFireAndForget: jest.fn() } as unknown as ServiceCtor[2],
    otherKey as unknown as ServiceCtor[3],
    registry,
  );
  const controller = new BlueprintsController(
    service,
    {} as ControllerCtor[1],
    {} as ControllerCtor[2],
    {} as ControllerCtor[3],
    {} as ControllerCtor[4],
    { DEFAULT_TENANT_ID: 'tenant-a' } as ControllerCtor[5],
  );
  return { controller, canvasModel };
}

describe('GET /blueprints/latest when the saved canvas cannot be loaded', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers 503 naming the encryption keys when a stored config cannot be decrypted', async () => {
    const { controller, canvasModel } = setup(async () => ({
      ...STORED,
      toObject: () => ({ ...STORED }),
    }));

    const load = controller.getLatestCanvas();

    await expect(load).rejects.toBeInstanceOf(ServiceUnavailableException);
    const error = (await load.catch((e: unknown) => e)) as ServiceUnavailableException;
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(error.message).toContain('could not be decrypted by this process');
    expect(error.message).toContain('ENCRYPTION_KEY');
    expect(error.message).toContain('Nothing was changed');
    // Nothing secret in the answer, and the stored canvas is not written
    expect(error.message).not.toContain('c2VjcmV0');
    expect(canvasModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('answers 503 for any other load failure, never an empty canvas', async () => {
    const { controller } = setup(async () => {
      throw new Error('connection 3 to mongodb.internal:27017 closed');
    });

    const load = controller.getLatestCanvas();

    await expect(load).rejects.toBeInstanceOf(ServiceUnavailableException);
    const error = (await load.catch((e: unknown) => e)) as ServiceUnavailableException;
    expect(error.message).toContain('could not be loaded');
    expect(error.message).not.toContain('decrypted');
    // The internal cause stays in the server log
    expect(error.message).not.toContain('mongodb.internal');
  });

  it('still answers an empty canvas without lastSaved when nothing is saved', async () => {
    const { controller } = setup(async () => null);

    const res = await controller.getLatestCanvas();

    expect(res).toMatchObject({ success: true, data: { nodes: [], edges: [] } });
    expect(res.lastSaved).toBeUndefined();
    // The first save sends it back (canvas-revision.integration.spec.ts)
    expect(res.revision).toBe(0);
  });

  it('returns the stored canvas revision for the save to send back', async () => {
    const { controller } = setup(async () => ({
      ...STORED,
      connectorConfigs: {},
      canvasRevision: 7,
      toObject() {
        return { ...STORED, connectorConfigs: {}, canvasRevision: 7 };
      },
    }));

    const res = await controller.getLatestCanvas();

    expect(res.revision).toBe(7);
  });
});
