import { Test } from '@nestjs/testing';
import type { ModuleRef } from '@nestjs/core';
import { ConfigActivities } from './config.activities';
import { BlueprintsService } from '../modules/blueprints/blueprints.service';
import { PluginRegistryService } from '../modules/connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../modules/connectors/plugin/register-connectors';
import { TEST_TENANT_ID } from '@testing/test-helpers';

describe('ConfigActivities', () => {
  let activities: ConfigActivities;
  let blueprintsService: jest.Mocked<Partial<BlueprintsService>>;

  beforeEach(async () => {
    blueprintsService = {
      getLatestBlueprint: jest.fn(),
    };
    // The real manifests: whether a connector is a target is theirs to say
    const registry = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(registry);

    const module = await Test.createTestingModule({
      providers: [
        ConfigActivities,
        { provide: BlueprintsService, useValue: blueprintsService },
        { provide: PluginRegistryService, useValue: registry },
      ],
    }).compile();

    activities = module.get(ConfigActivities);
  });

  describe('getActiveTargetSystems', () => {
    it('should throw when tenantId is empty', async () => {
      await expect(activities.getActiveTargetSystems('')).rejects.toThrow(
        '[SECURITY] tenantId is required for all activity operations',
      );
    });

    it('should return systems from blueprint nodes', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [
          { type: 'hub', data: {} },
          { type: 'connector', data: { type: 'entra-id' } },
          { type: 'connector', data: { type: 'ad' } },
        ],
      });

      const result = await activities.getActiveTargetSystems(TEST_TENANT_ID);

      expect(result).toContain('entra');
      expect(result).toContain('ad');
    });

    it('returns the target connectors of a saved canvas, never its HR sources', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [
          { id: 'csv-hr-source', data: { role: 'source', type: 'csv-hr' } },
          { id: 'json-api-hr-source-2', data: { role: 'source', type: 'json-api-hr' } },
          { id: 'euroid-core', data: { role: 'brain' } },
          { id: 'entra-target', data: { role: 'target', type: 'entra-id' } },
          { id: 'okta-target-1', data: { role: 'target', type: 'okta' } },
          { id: 'file-outbound-1', data: { role: 'target', type: 'file-outbound' } },
          { id: 'discord-webhook-1', data: { role: 'target', type: 'discord-webhook' } },
        ],
      });

      const result = await activities.getActiveTargetSystems(TEST_TENANT_ID);

      expect(result).toEqual(['entra', 'okta', 'file-outbound', 'discord-webhook']);
    });

    it('keeps the legacy canvas spellings of a target (entra-target, active-directory)', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [
          { id: 'n1', data: { type: 'entra-target' } },
          { id: 'n2', data: { type: 'active-directory' } },
          { id: 'n3', data: { role: 'source', type: 'csv-hr' } },
        ],
      });

      await expect(activities.getActiveTargetSystems(TEST_TENANT_ID)).resolves.toEqual([
        'entra',
        'ad',
      ]);
    });

    it('keeps a connector type no manifest describes, so its health check reports it', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [{ id: 'jira-1', data: { role: 'target', type: 'jira' } }],
      });

      await expect(activities.getActiveTargetSystems(TEST_TENANT_ID)).resolves.toEqual(['jira']);
    });

    // Plan 2.0da: the default canvas's Entra ID node had no data.type, so a tenant that saved
    // the default canvas onboarded nobody to Entra ID, with no error.
    it('targets the Entra ID node of a canvas saved from the old default canvas (no data.type)', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [
          { id: 'csv-hr-source', type: 'connectorNode', data: { role: 'source', type: 'csv-hr' } },
          { id: 'euroid-core', type: 'connectorNode', data: { role: 'brain' } },
          {
            id: 'entra-target',
            type: 'connectorNode',
            data: { role: 'target', healthStatus: 'unknown' },
          },
        ],
      });

      await expect(activities.getActiveTargetSystems(TEST_TENANT_ID)).resolves.toEqual(['entra']);
    });

    it('names an untyped node only when it is a target whose id names a registered connector', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [
          // The default canvas before 4782c750: Workday HR -> Brain -> Entra ID + Salesforce
          { id: 'workday-source', data: { role: 'source' } },
          { id: 'euroid-core', data: { role: 'brain' } },
          { id: 'entra-target', data: { role: 'target' } },
          { id: 'salesforce-target', data: { role: 'target' } },
          // Not a target, although its id names AD
          { id: 'ad-source', data: { role: 'source' } },
          { id: 'active-directory-target-2', data: { role: 'target' } },
        ],
      });

      await expect(activities.getActiveTargetSystems(TEST_TENANT_ID)).resolves.toEqual([
        'entra',
        'ad',
      ]);
    });

    it('should return empty array on error', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockRejectedValue(new Error('DB error'));

      const result = await activities.getActiveTargetSystems(TEST_TENANT_ID);

      expect(result).toEqual([]);
    });
  });

  describe('getConnectorConfig', () => {
    it('should return config when node found', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [{ id: 'entra-id', data: { type: 'entra-id', config: { tenantId: 't1' } } }],
      });

      const result = await activities.getConnectorConfig('entra-id', TEST_TENANT_ID);

      expect(result).toEqual({ tenantId: 't1' });
    });

    it('should return null when connector not found', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [],
      });

      const result = await activities.getConnectorConfig('missing', TEST_TENANT_ID);

      expect(result).toBeNull();
    });

    // Onboarding, the mover and offboarding ask for 'entra-id'; the old default canvas's node is
    // 'entra-target' with no data.type, so its Design studio config was never found.
    it('finds the config of the untyped entra-target node for entra-id, and only for it', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [
          {
            id: 'csv-hr-source',
            data: { role: 'source', type: 'csv-hr', config: { filePath: 'x' } },
          },
          { id: 'entra-target', data: { role: 'target', config: { tenantId: 't1' } } },
        ],
      });

      await expect(activities.getConnectorConfig('entra-id', TEST_TENANT_ID)).resolves.toEqual({
        tenantId: 't1',
      });
      await expect(activities.getConnectorConfig('ad', TEST_TENANT_ID)).resolves.toBeNull();
    });

    it('prefers a node whose id or type names the connector over an untyped entra-target', async () => {
      (blueprintsService.getLatestBlueprint as jest.Mock).mockResolvedValue({
        nodes: [
          { id: 'entra-target', data: { role: 'target', config: { tenantId: 'old' } } },
          {
            id: 'microsoft-entra-id-target-1',
            data: { role: 'target', type: 'entra-id', config: { tenantId: 'new' } },
          },
        ],
      });

      await expect(activities.getConnectorConfig('entra-id', TEST_TENANT_ID)).resolves.toEqual({
        tenantId: 'new',
      });
    });
  });
});
