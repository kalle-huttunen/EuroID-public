import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BlueprintsService } from './blueprints.service';
import { BlueprintNode, CanvasBlueprint } from './schemas/blueprint.schema';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest
    .fn()
    .mockReturnValue({ tenantId: 'test-tenant', actor: 'ops@corp.example' }),
}));

jest.mock('@infrastructure/secrets/config-encryption.helper', () => ({
  encryptConfigIfNeeded: jest.fn((_enc, config) => config),
  decryptConfigIfEncrypted: jest.fn((_enc, config) => config),
}));

describe('BlueprintsService', () => {
  let service: BlueprintsService;
  let mockBlueprintModel: Record<string, jest.Mock>;
  let mockCanvasModel: Record<string, jest.Mock>;
  let mockAuditService: Record<string, jest.Mock>;
  let mockEncryption: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockBlueprintModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([]),
      }),
    };

    mockCanvasModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(null),
    };

    mockAuditService = {
      logFireAndForget: jest.fn(),
    };

    mockEncryption = {
      encrypt: jest.fn((v) => v),
      decrypt: jest.fn((v) => v),
    };

    const module = await Test.createTestingModule({
      providers: [
        BlueprintsService,
        { provide: getModelToken(BlueprintNode.name), useValue: mockBlueprintModel },
        { provide: getModelToken(CanvasBlueprint.name), useValue: mockCanvasModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: EncryptionService, useValue: mockEncryption },
        {
          provide: PluginRegistryService,
          useValue: { getSecretConfigKeys: jest.fn(), getAllSecretConfigKeys: () => new Set() },
        },
      ],
    }).compile();

    service = module.get<BlueprintsService>(BlueprintsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── updateNodeConfig ──────────────────────────────────────────────────

  describe('updateNodeConfig', () => {
    it('should upsert and return config', async () => {
      const nodeId = 'node-1';
      const updateData = { label: 'HR Source', config: { url: 'https://example.com' } };
      const returnedDoc = { nodeId, ...updateData };

      mockBlueprintModel.findOneAndUpdate.mockResolvedValue(returnedDoc);

      const result = await service.updateNodeConfig(nodeId, updateData);

      expect(mockBlueprintModel.findOneAndUpdate).toHaveBeenCalledWith(
        { nodeId, tenantId: 'test-tenant' },
        { $set: { ...updateData, tenantId: 'test-tenant' } },
        { upsert: true, new: true },
      );
      expect(result).toBe(returnedDoc);
    });

    // Hunt 05 F17: saving a node's connector settings (secrets included) left no audit entry
    it('audits who saved which settings of the node, never their values', async () => {
      mockBlueprintModel.findOneAndUpdate.mockResolvedValue({ nodeId: 'node-1' });

      await service.updateNodeConfig('node-1', {
        nodeType: 'scim',
        config: { baseUrl: 'https://scim.example.com', bearerToken: 's3cret-token' },
      });

      expect(mockAuditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CONFIG_CHANGED',
          actor: 'ops@corp.example',
          resourceType: 'blueprint-node',
          resourceId: 'node-1',
          payload: { metadata: { nodeType: 'scim', configKeys: ['baseUrl', 'bearerToken'] } },
        }),
      );
      expect(JSON.stringify(mockAuditService.logFireAndForget.mock.calls)).not.toContain(
        's3cret-token',
      );
    });
  });

  // ── getNodeConfig ─────────────────────────────────────────────────────

  describe('getNodeConfig', () => {
    it('should return config from blueprintModel', async () => {
      const nodeId = 'node-1';
      const doc = { nodeId, config: { url: 'https://example.com' } };

      mockBlueprintModel.findOne.mockResolvedValue(doc);

      const result = await service.getNodeConfig(nodeId);

      expect(mockBlueprintModel.findOne).toHaveBeenCalledWith({ nodeId, tenantId: 'test-tenant' });
      expect(result).toBe(doc);
    });

    it('should fall back to canvas when blueprintModel returns null', async () => {
      const nodeId = 'node-2';

      mockBlueprintModel.findOne.mockResolvedValue(null);

      const canvasDoc = {
        nodes: [
          { id: 'node-1', data: { type: 'entra-id', config: { tenantId: 'other-node' } } },
          { id: nodeId, data: { type: 'source-workday', config: { url: 'https://canvas.com' } } },
        ],
        edges: [],
        connectorConfigs: {},
      };
      mockCanvasModel.findOne.mockResolvedValue(canvasDoc);

      const result = await service.getNodeConfig(nodeId);

      expect(mockCanvasModel.findOne).toHaveBeenCalledWith({
        version: 'draft',
        tenantId: 'test-tenant',
      });
      expect(result).toEqual({
        nodeId,
        nodeType: 'source-workday',
        config: { url: 'https://canvas.com' },
      });
    });

    it('should return null when nothing found', async () => {
      const nodeId = 'nonexistent';

      mockBlueprintModel.findOne.mockResolvedValue(null);
      mockCanvasModel.findOne.mockResolvedValue(null);

      const result = await service.getNodeConfig(nodeId);

      expect(result).toBeNull();
    });
  });

  // ── saveBlueprint ─────────────────────────────────────────────────────

  describe('saveBlueprint', () => {
    it('should save canvas and call audit', async () => {
      const canvasData = {
        nodes: [{ id: 'node-1', type: 'source-workday', data: {} }],
        edges: [{ id: 'edge-1', source: 'node-1', target: 'node-2' }],
      };

      const savedDoc = { _id: 'canvas-1', ...canvasData };
      mockCanvasModel.findOneAndUpdate.mockResolvedValue(savedDoc);

      const result = await service.saveBlueprint(canvasData);

      expect(mockCanvasModel.findOneAndUpdate).toHaveBeenCalled();
      expect(mockAuditService.logFireAndForget).toHaveBeenCalled();
    });

    // Hunt 05 F17: the audit actor was the literal 'admin'
    it('audits the signed-in user as the actor', async () => {
      mockCanvasModel.findOneAndUpdate.mockResolvedValue({ _id: 'canvas-1' });

      await service.saveBlueprint({ nodes: [], edges: [] });

      expect(mockAuditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CONFIG_CHANGED', actor: 'ops@corp.example' }),
      );
    });

    // Hunt 05 F12: an impact analysis from before the save no longer unlocks Deploy
    it('stamps when the canvas was saved, for the Deploy readiness check', async () => {
      mockCanvasModel.findOneAndUpdate.mockResolvedValue({ _id: 'canvas-1' });

      await service.saveBlueprint({ nodes: [], edges: [] });

      const [, update] = mockCanvasModel.findOneAndUpdate.mock.calls[0];
      expect(update.$set['pipelineConfig.canvasSavedAt']).toBeInstanceOf(Date);
    });
  });

  // ── getLatestBlueprint ────────────────────────────────────────────────

  describe('getLatestBlueprint', () => {
    it('should return empty canvas when none exists', async () => {
      mockCanvasModel.findOne.mockResolvedValue(null);

      const result = await service.getLatestBlueprint();

      expect(result).toEqual(
        expect.objectContaining({
          nodes: [],
          edges: [],
        }),
      );
    });
  });

  // ── getHrPriorityFromBlueprint ────────────────────────────────────────

  /** A saved canvas: getLatestBlueprint reads its nodes, and the rest from toObject(). */
  const savedCanvas = (nodes: unknown[]) => ({
    nodes,
    edges: [],
    connectorConfigs: {},
    toObject: () => ({ nodes, edges: [], connectorConfigs: {} }),
  });

  describe('getHrPriorityFromBlueprint', () => {
    const canvasDoc = savedCanvas([
      {
        id: 'node-1',
        data: {
          role: 'source',
          type: 'workday',
          config: { ingestPriority: 1, contractTag: 'FTE', masteryFields: ['email'] },
        },
      },
      {
        id: 'node-2',
        data: { role: 'source', type: 'bamboohr', config: { ingestPriority: 2 } },
      },
      {
        id: 'entra-target',
        data: { role: 'target', type: 'entra-id', config: { ingestPriority: 9 } },
      },
    ]);

    it('should return priority for matching source', async () => {
      mockCanvasModel.findOne.mockResolvedValue(canvasDoc);

      const result = await service.getHrPriorityFromBlueprint('workday');

      expect(result).toEqual({ ingestPriority: 1, contractTag: 'FTE', masteryFields: ['email'] });
    });

    it('should return null for unknown source', async () => {
      mockCanvasModel.findOne.mockResolvedValue(canvasDoc);

      const result = await service.getHrPriorityFromBlueprint('unknown-source');

      expect(result).toBeNull();
    });
  });

  // ── getHrConnectorsWithPriorityFromBlueprint ──────────────────────────

  describe('getHrConnectorsWithPriorityFromBlueprint', () => {
    it('should return sorted connectors', async () => {
      mockCanvasModel.findOne.mockResolvedValue(
        savedCanvas([
          {
            id: 'node-1',
            data: { role: 'source', type: 'workday', config: { ingestPriority: 2 } },
          },
          {
            id: 'node-2',
            data: {
              role: 'source',
              type: 'bamboohr',
              config: { ingestPriority: 1, contractTag: 'FTE' },
            },
          },
          // Not one of the HR source tags
          { id: 'node-3', data: { role: 'source', type: 'csv', config: { ingestPriority: 0 } } },
        ]),
      );

      const result = await service.getHrConnectorsWithPriorityFromBlueprint(['workday', 'bamboo']);

      expect(result).toEqual([
        { name: 'bamboohr', ingestPriority: 1, contractTag: 'FTE' },
        { name: 'workday', ingestPriority: 2 },
      ]);
    });

    it('should return empty array for empty tags', async () => {
      const canvasDoc = {
        nodes: [],
        edges: [],
        connectorConfigs: {},
        toObject: jest.fn().mockReturnValue({
          nodes: [],
          edges: [],
          connectorConfigs: {},
        }),
      };

      mockCanvasModel.findOne.mockResolvedValue(canvasDoc);

      const result = await service.getHrConnectorsWithPriorityFromBlueprint([]);

      expect(result).toEqual([]);
    });
  });

  // ── getConnectorConfigForImpact ───────────────────────────────────────

  describe('getConnectorConfigForImpact', () => {
    it('should return config for matching connector type', async () => {
      const canvasDoc = {
        nodes: [
          {
            id: 'target-entra-1',
            type: 'target-entra-id',
            data: { type: 'target-entra-id', config: { tenantId: 'abc-123', clientId: 'def-456' } },
          },
        ],
        edges: [],
        connectorConfigs: {},
        toObject: jest.fn().mockReturnValue({
          nodes: [
            {
              id: 'target-entra-1',
              type: 'target-entra-id',
              data: {
                type: 'target-entra-id',
                config: { tenantId: 'abc-123', clientId: 'def-456' },
              },
            },
          ],
          edges: [],
          connectorConfigs: {},
        }),
      };

      mockCanvasModel.findOne.mockResolvedValue(canvasDoc);

      const result = await service.getConnectorConfigForImpact('target-entra-id');

      expect(result).toEqual({ tenantId: 'abc-123', clientId: 'def-456' });
    });
  });
});
