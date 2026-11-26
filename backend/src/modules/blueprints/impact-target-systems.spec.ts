/**
 * The impact analysis counted every canvas node but the hub as a target system: each HR source
 * node gave every user a CREATE delta, inflating affectedPercentage and the risk level that
 * gates Deploy. And `includes('ad')` read types such as "workday" or "adp" as Active Directory
 * (hunt r2-05 N8).
 */
import { ImpactAnalysisService } from './impact-analysis.service';
import { impactTargetSystem } from './impact-delta.util';
import { createMockUser } from '@testing/mock-factories';

describe('impactTargetSystem', () => {
  it.each([
    ['entra-id', 'entra-id'],
    ['Microsoft Entra ID', 'entra-id'],
    ['azure-ad', 'entra-id'],
    ['ad', 'ad'],
    ['active-directory', 'ad'],
    ['workday', 'workday'],
    ['adp', 'adp'],
    ['scim', 'scim'],
  ])('%s is %s', (type, system) => {
    expect(impactTargetSystem(type)).toBe(system);
  });
});

describe('ImpactAnalysisService target systems of the canvas', () => {
  it("analyses the canvas's target nodes only, never its HR sources", async () => {
    const nodes = [
      { id: 'hub', type: 'hub', data: {} },
      { id: 'csv-hr-source', data: { role: 'source', type: 'csv-hr' } },
      { id: 'workday-source', data: { role: 'source', type: 'workday' } },
      { id: 'entra-target', data: { role: 'target', type: 'entra-id' } },
      { id: 'scim-target', data: { role: 'target', type: 'scim' } },
    ];
    const service = new ImpactAnalysisService(
      { findIdentityByEmail: jest.fn().mockResolvedValue(null) } as never,
      { evaluate: jest.fn().mockResolvedValue({ operations: [] }) } as never,
      { getLatestBlueprint: jest.fn().mockResolvedValue({ nodes }) } as never,
      {} as never,
    );

    const result = await service.computeDeltas('tenant-a', { users: [createMockUser()] });

    expect(result.deltas.map((d) => d.targetSystem).sort()).toEqual(['entra-id', 'scim']);
  });

  // Final review RC6: a canvas saved before nodes had a role picked no target, so the analysis
  // fell back to Entra ID and reported deltas for a system the canvas does not have
  it('takes the nodes of a canvas saved before roles existed as targets, except the hub', async () => {
    const nodes = [
      { id: 'hub', type: 'hub', data: { type: 'hub' } },
      { id: 'n1', data: { type: 'scim' } },
      { id: 'n2', type: 'connector', data: { type: 'active-directory' } },
      { id: 'n3', data: { role: 'source', type: 'csv-hr' } },
    ];
    const service = new ImpactAnalysisService(
      { findIdentityByEmail: jest.fn().mockResolvedValue(null) } as never,
      { evaluate: jest.fn().mockResolvedValue({ operations: [] }) } as never,
      { getLatestBlueprint: jest.fn().mockResolvedValue({ nodes }) } as never,
      {} as never,
    );

    const result = await service.computeDeltas('tenant-a', { users: [createMockUser()] });

    expect(result.deltas.map((d) => d.targetSystem).sort()).toEqual(['ad', 'scim']);
  });
});
