/**
 * Design studio saves on in-memory MongoDB: two admins saving the same canvas.
 *
 * saveBlueprint was an unconditional read-modify-write, so the second of two admins to save
 * silently overwrote the first one's canvas (HX-F report follow-up, hunt 05 F18). The canvas now
 * has a revision: GET /blueprints/latest returns it, the studio sends it back with its save, and
 * a save of an older revision is refused with 409 and changes nothing. A client that sends no
 * revision (one from before this release) still saves, audited as unchecked.
 *
 * Each save's audit entry also names the connectors whose settings it changed
 * (`connectorConfigChanges`), which the ISO 27001 report counts as connector configuration
 * changes; before, it counted every canvas save (HX-G report follow-up).
 */
import { ConflictException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import mongoose, { Connection, Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { BlueprintsService } from './blueprints.service';
import { CanvasBlueprint, CanvasBlueprintSchema } from './schemas/blueprint.schema';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../connectors/plugin/register-connectors';
import { SECRET_PLACEHOLDER } from '@infrastructure/secrets/config-secret-mask';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'tenant-a', actor: 'ada@corp.example' }),
}));

type Ctor = ConstructorParameters<typeof BlueprintsService>;

const node = (id: string) => ({ id, type: 'connectorNode', position: { x: 0, y: 0 }, data: {} });

describe('BlueprintsService canvas revision (MongoDB)', () => {
  let connection: Connection;
  let canvasModel: Model<CanvasBlueprint>;
  let audit: { logFireAndForget: jest.Mock };
  let service: BlueprintsService;

  beforeAll(async () => {
    connection = await mongoose.createConnection(testDbUri()).asPromise();
    canvasModel = connection.model(
      CanvasBlueprint.name,
      CanvasBlueprintSchema,
    ) as unknown as Model<CanvasBlueprint>;
  });

  afterAll(async () => {
    await connection?.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await canvasModel.collection.deleteMany({});
    const registry = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(registry);
    audit = { logFireAndForget: jest.fn() };
    service = new BlueprintsService(
      {} as Ctor[0],
      canvasModel as unknown as Ctor[1],
      audit as unknown as Ctor[2],
      // A reversible stand-in, so a stored config with a secret reads back as saved
      {
        encrypt: (v: string) => `enc:${v}`,
        decrypt: (v: string) => v.slice('enc:'.length),
        isEncrypted: (v: string) => v.startsWith('enc:'),
      } as unknown as Ctor[3],
      registry,
    );
  });

  const storedNodeIds = async () => {
    const canvas = await canvasModel.collection.findOne({ tenantId: 'tenant-a', version: 'draft' });
    return ((canvas?.nodes ?? []) as Array<{ id: string }>).map((n) => n.id);
  };

  it('gives a first save revision 1, and the next save of that revision 2', async () => {
    expect((await service.getLatestBlueprint()).canvasRevision ?? 0).toBe(0);

    const first = await service.saveBlueprint({ nodes: [node('a')], edges: [], revision: 0 });
    const second = await service.saveBlueprint({ nodes: [node('b')], edges: [], revision: 1 });

    expect(first.canvasRevision).toBe(1);
    expect(second.canvasRevision).toBe(2);
    expect((await service.getLatestBlueprint()).canvasRevision).toBe(2);
  });

  it("refuses the save of an admin who loaded before another's save, and keeps that save", async () => {
    await service.saveBlueprint({ nodes: [node('start')], edges: [], revision: 0 });
    // Ada and Bob both loaded revision 1; Ada saves first
    await service.saveBlueprint({ nodes: [node('ada')], edges: [], revision: 1 });

    const bob = service.saveBlueprint({ nodes: [node('bob')], edges: [], revision: 1 });

    await expect(bob).rejects.toBeInstanceOf(ConflictException);
    await expect(bob).rejects.toThrow(/reload/i);
    expect(await storedNodeIds()).toEqual(['ada']);
  });

  it('lets one of two saves of the same revision through, at the same moment too', async () => {
    await service.saveBlueprint({ nodes: [node('start')], edges: [], revision: 0 });

    const results = await Promise.allSettled([
      service.saveBlueprint({ nodes: [node('ada')], edges: [], revision: 1 }),
      service.saveBlueprint({ nodes: [node('bob')], edges: [], revision: 1 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictException);
    const kept = results.findIndex((r) => r.status === 'fulfilled') === 0 ? 'ada' : 'bob';
    expect(await storedNodeIds()).toEqual([kept]);
    expect((await service.getLatestBlueprint()).canvasRevision).toBe(2);
  });

  it('reads a canvas saved before revisions existed as revision 0', async () => {
    await canvasModel.collection.insertOne({
      tenantId: 'tenant-a',
      version: 'draft',
      nodes: [node('old')],
      edges: [],
    });

    expect((await service.getLatestBlueprint()).canvasRevision ?? 0).toBe(0);
    const saved = await service.saveBlueprint({ nodes: [node('new')], edges: [], revision: 0 });

    expect(saved.canvasRevision).toBe(1);
  });

  it('still saves for a client that sends no revision, audited as unchecked', async () => {
    await service.saveBlueprint({ nodes: [node('start')], edges: [], revision: 0 });

    const saved = await service.saveBlueprint({ nodes: [node('old-client')], edges: [] });

    expect(saved.canvasRevision).toBe(2);
    expect(await storedNodeIds()).toEqual(['old-client']);
    const [checked, unchecked] = audit.logFireAndForget.mock.calls.map(([entry]) => entry);
    expect(checked.payload.metadata).toEqual(
      expect.objectContaining({ revision: 1, revisionChecked: true }),
    );
    expect(unchecked.payload.metadata).toEqual(
      expect.objectContaining({ revision: 2, revisionChecked: false }),
    );
    expect(unchecked.description).toMatch(/unchecked/i);
  });

  it('names in the audit entry the connectors whose settings a save changed, and only those', async () => {
    const entra = (config: Record<string, unknown>, x = 0) => ({
      id: 'entra-1',
      type: 'connectorNode',
      position: { x, y: 0 },
      data: { type: 'entra-id', config },
    });
    const brain = (threshold: number) => ({ 'euroid-core': { correlationConfig: { threshold } } });
    const changesOf = (call: number) =>
      audit.logFireAndForget.mock.calls[call][0].payload.metadata.connectorConfigChanges;

    await service.saveBlueprint({
      nodes: [entra({ tenantId: 't-1', clientSecret: 's3cret' })],
      edges: [],
      connectorConfigs: brain(1),
      revision: 0,
    });
    // The studio sends the masked secret back and has only moved the node
    await service.saveBlueprint({
      nodes: [entra({ tenantId: 't-1', clientSecret: SECRET_PLACEHOLDER }, 50)],
      edges: [],
      connectorConfigs: brain(1),
      revision: 1,
    });
    // The Brain's correlation settings are no connector's
    await service.saveBlueprint({
      nodes: [entra({ tenantId: 't-1', clientSecret: SECRET_PLACEHOLDER }, 50)],
      edges: [],
      connectorConfigs: brain(2),
      revision: 2,
    });
    await service.saveBlueprint({
      nodes: [entra({ tenantId: 't-2', clientSecret: SECRET_PLACEHOLDER }, 50)],
      edges: [],
      connectorConfigs: { ...brain(2), 'entra-id': { defaultDomain: 'corp.example' } },
      revision: 3,
    });

    expect(changesOf(0)).toEqual(['entra-id']);
    expect(changesOf(1)).toEqual([]);
    expect(changesOf(2)).toEqual([]);
    expect(changesOf(3)).toEqual(['entra-id']);
  });
});
