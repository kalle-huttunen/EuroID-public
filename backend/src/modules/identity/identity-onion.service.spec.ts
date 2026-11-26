import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { IdentityOnionService } from './identity-onion.service';
import type { IdentityDocument } from './schemas/identity.schema';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { createMockLoggerFactory } from '@testing/test-helpers';
import { TEST_TENANT_ID, withTestTenant } from '@testing/test-helpers';

function createChainable(resolvedValue: unknown = null) {
  return {
    session: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  };
}

describe('IdentityOnionService', () => {
  let service: IdentityOnionService;
  let mockIdentityModel: { findOne: jest.Mock };
  let mockReconConfigService: { getHrSourceTags: jest.Mock };
  const { factory: loggerFactory } = createMockLoggerFactory();

  beforeEach(async () => {
    mockIdentityModel = {
      findOne: jest.fn().mockReturnValue(createChainable()),
    };
    mockReconConfigService = {
      getHrSourceTags: jest.fn().mockResolvedValue(['hr', 'workday']),
    };

    const module = await Test.createTestingModule({
      providers: [
        IdentityOnionService,
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: ReconciliationConfigService, useValue: mockReconConfigService },
        { provide: LoggerFactoryService, useValue: loggerFactory },
      ],
    }).compile();

    service = module.get(IdentityOnionService);
    jest.clearAllMocks();
  });

  // ── buildProfileWithContractsForPolicy ────────────────────────

  describe('buildProfileWithContractsForPolicy', () => {
    it('should extract contract from single HR source with title and department', async () => {
      const identity = {
        tenantId: TEST_TENANT_ID,
        profile: { email: 'john@example.com', firstName: 'John' },
        sources: [
          {
            sourceName: 'workday-hr',
            externalId: 'EMP-001',
            rawData: { jobTitle: 'Engineer', departmentName: 'R&D' },
            sourceRole: 'primary-hr',
          },
        ],
        metadata: { primaryHrSource: 'workday-hr' },
      };

      const result = await withTestTenant(() =>
        service.buildProfileWithContractsForPolicy(identity as any),
      );

      expect(result.contracts).toHaveLength(1);
      expect((result.contracts as any[])[0]).toMatchObject({
        title: 'Engineer',
        department: 'R&D',
        isPrimary: true,
        status: 'ACTIVE',
      });
    });

    it('should determine primary from multiple HR sources', async () => {
      const identity = {
        tenantId: TEST_TENANT_ID,
        profile: { email: 'jane@example.com' },
        sources: [
          {
            sourceName: 'workday-hr',
            externalId: 'EMP-001',
            rawData: { jobTitle: 'Manager', departmentName: 'Ops' },
            sourceRole: 'primary-hr',
          },
          {
            sourceName: 'secondary-hr',
            externalId: 'EMP-002',
            rawData: { jobTitle: 'Consultant', department: 'Finance' },
            sourceRole: 'secondary-hr',
          },
        ],
        metadata: { primaryHrSource: 'workday-hr' },
      };

      const result = await withTestTenant(() =>
        service.buildProfileWithContractsForPolicy(identity as any),
      );

      expect(result.contracts).toHaveLength(2);
      // Primary source is workday-hr (matches metadata.primaryHrSource + first index)
      const contracts = result.contracts as any[];
      expect(contracts[0]).toMatchObject({ title: 'Manager', department: 'Ops', isPrimary: true });
      // Secondary source should NOT be primary (sourceName doesn't match primaryHrSource, not index 0)
      expect(contracts[1]).toMatchObject({
        title: 'Consultant',
        department: 'Finance',
        isPrimary: false,
      });
    });

    it('should return undefined contracts when no HR sources have title/department', async () => {
      const identity = {
        tenantId: TEST_TENANT_ID,
        profile: { email: 'nobody@example.com' },
        sources: [
          { sourceName: 'entra-id', externalId: 'obj-1', rawData: {}, sourceRole: 'target' },
        ],
        metadata: {},
      };

      const result = await withTestTenant(() =>
        service.buildProfileWithContractsForPolicy(identity as any),
      );

      expect(result.contracts).toBeUndefined();
    });

    describe('after a manual edit of the department (metadata.manualOverrides)', () => {
      /** Edited to Sales by hand; the primary HR record still says Engineering. */
      const edited = (primaryDepartment: string) =>
        ({
          tenantId: TEST_TENANT_ID,
          profile: { email: 'ada@example.com', departmentName: 'Sales', jobTitle: 'Engineer' },
          sources: [
            {
              sourceName: 'workday-hr',
              externalId: 'EMP-1',
              rawData: { jobTitle: 'Engineer', departmentName: primaryDepartment },
              sourceRole: 'primary-hr',
            },
            {
              sourceName: 'bamboo-hr',
              externalId: 'EMP-2',
              rawData: { jobTitle: 'Advisor', departmentName: 'Research' },
              sourceRole: 'secondary-hr',
            },
          ],
          metadata: {
            primaryHrSource: 'workday-hr',
            manualOverrides: { departmentName: { 'workday-hr': 'Engineering' } },
          },
        }) as unknown as IdentityDocument;

      it('gives the overridden contract the edited department, and keeps the other contract', async () => {
        const result = await withTestTenant(() =>
          service.buildProfileWithContractsForPolicy(edited('Engineering')),
        );

        expect(result.contracts).toEqual([
          expect.objectContaining({ id: 'EMP-1', title: 'Engineer', department: 'Sales' }),
          expect.objectContaining({ id: 'EMP-2', title: 'Advisor', department: 'Research' }),
        ]);
      });

      it('lets HR win again once it sends another department', async () => {
        const result = await withTestTenant(() =>
          service.buildProfileWithContractsForPolicy(edited('Marketing')),
        );

        expect(result.contracts).toEqual([
          expect.objectContaining({ id: 'EMP-1', department: 'Marketing' }),
          expect.objectContaining({ id: 'EMP-2', department: 'Research' }),
        ]);
      });
    });
  });

  // The finders (findIdentityByEmail, ById, BySourceKey) run on MongoDB with two tenants in
  // identity-onion.service.integration.spec.ts
});
