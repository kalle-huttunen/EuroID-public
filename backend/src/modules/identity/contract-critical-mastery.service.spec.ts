/**
 * The saves that store mastery refuse an owner other than the primary HR contract for a
 * contract-critical field (owner decision 2026-11-24): PUT /admin/reconciliation-config (default
 * mastery) and POST /blueprints/save (the Brain's Field Mastery, an HR source node's mastery
 * fields). Both used to store such an entry, which reconcile then ignored or let a secondary win.
 */
import { BadRequestException } from '@nestjs/common';
import { ContractCriticalMasteryService } from './contract-critical-mastery.service';
import { ReconciliationConfigController } from './reconciliation-config.controller';

const CONFIG = {
  hrSourceTags: ['csv-hr', 'json-api-hr'],
  sourcePriorityOrder: ['csv-hr', 'json-api-hr'],
  contractCriticalFields: ['departmentName', 'jobTitle'],
  defaultMastery: {} as Record<string, string[]>,
  targetIdKeys: [],
};

const sourceNode = (type: string, config: Record<string, unknown>) => ({
  id: `${type}-source`,
  position: { x: 0, y: 0 },
  data: { role: 'source', type, config },
});

describe('Contract-critical mastery on save', () => {
  const reconConfig = { getConfig: jest.fn(), upsertConfig: jest.fn() };
  const correlation = {
    getHrConnectorsWithPriorityFromBlueprint: jest.fn(),
    getInstalledHrConnectorsWithPriority: jest.fn(),
  };
  const service = new ContractCriticalMasteryService(reconConfig as never, correlation as never);
  const controller = new ReconciliationConfigController(reconConfig as never, service);
  const admin = { tenantId: 'tenant-a', email: 'admin@corp.example' } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    reconConfig.getConfig.mockResolvedValue(CONFIG);
    reconConfig.upsertConfig.mockImplementation(async (_t: string, dto: unknown) => dto);
    correlation.getHrConnectorsWithPriorityFromBlueprint.mockResolvedValue([]);
    correlation.getInstalledHrConnectorsWithPriority.mockResolvedValue([]);
  });

  describe('PUT /admin/reconciliation-config', () => {
    it('refuses a default mastery naming a target or a secondary HR source, and saves nothing', async () => {
      const body = {
        ...CONFIG,
        defaultMastery: { departmentName: ['entra-id'], jobTitle: ['json-api-hr'] },
      };

      const refused = controller.upsertConfig(admin, body);

      await expect(refused).rejects.toThrow(BadRequestException);
      await expect(refused).rejects.toThrow(
        'Default mastery: departmentName names entra-id; Default mastery: jobTitle names ' +
          'json-api-hr. Contract-critical fields always come from the primary HR contract (now ' +
          'csv-hr)',
      );
      expect(reconConfig.upsertConfig).not.toHaveBeenCalled();
    });

    it('takes the primary from the Contract Tag of the Design studio source nodes', async () => {
      correlation.getHrConnectorsWithPriorityFromBlueprint.mockResolvedValue([
        { name: 'json-api-hr', ingestPriority: 2, contractTag: 'PRIMARY' },
        { name: 'csv-hr', ingestPriority: 1, contractTag: 'SECONDARY' },
      ]);

      await controller.upsertConfig(admin, {
        ...CONFIG,
        defaultMastery: { departmentName: ['json-api-hr'], email: ['entra-id'] },
      });

      expect(reconConfig.upsertConfig).toHaveBeenCalledTimes(1);
      expect(correlation.getHrConnectorsWithPriorityFromBlueprint).toHaveBeenCalledWith(
        CONFIG.hrSourceTags,
      );
    });
  });

  describe('POST /blueprints/save', () => {
    const nodes = [
      sourceNode('csv-hr', { contractTag: 'PRIMARY', ingestPriority: 1 }),
      sourceNode('json-api-hr', { contractTag: 'SECONDARY', ingestPriority: 2 }),
    ];
    const brain = (fieldMasteryOverrides: Record<string, string[]>) => ({
      'euroid-core': { correlationConfig: { rules: [], fieldMasteryOverrides } },
    });

    it("refuses the Brain's Field Mastery naming a target for a contract-critical field", async () => {
      await expect(
        service.assertCanvas({ nodes, connectorConfigs: brain({ departmentName: ['entra-id'] }) }),
      ).rejects.toThrow('Field Mastery: departmentName names entra-id');
    });

    it("refuses a secondary HR source node's mastery of a contract-critical field", async () => {
      const withMastery = [
        nodes[0],
        sourceNode('json-api-hr', {
          contractTag: 'SECONDARY',
          ingestPriority: 2,
          masteryFields: ['jobTitle', 'location'],
        }),
      ];

      await expect(service.assertCanvas({ nodes: withMastery })).rejects.toThrow(
        'Field Mastery of source json-api-hr: jobTitle names json-api-hr',
      );
    });

    it('accepts the primary named for a contract-critical field, and any owner of other fields', async () => {
      await expect(
        service.assertCanvas({
          nodes,
          connectorConfigs: brain({ departmentName: ['csv-hr'], email: ['entra-id'] }),
        }),
      ).resolves.toBeUndefined();
    });

    it('checks nothing for a tenant without a Recon Config (no field is contract-critical)', async () => {
      reconConfig.getConfig.mockResolvedValue(null);

      await expect(
        service.assertCanvas({ nodes, connectorConfigs: brain({ departmentName: ['entra-id'] }) }),
      ).resolves.toBeUndefined();
    });
  });
});
