import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { DsarExportService } from './dsar-export.service';
import { AuditService } from '../audit/audit.service';
import { IdentityEntitlementsService } from '../identity/identity-entitlements.service';
import { ConsentService } from './consent.service';
import { ERASURE_TARGETS } from './gdpr-erasure-scope';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('DsarExportService', () => {
  let service: DsarExportService;
  let auditService: jest.Mocked<Partial<AuditService>>;

  const mockIdentity = {
    _id: 'id-1',
    tenantId: 'test-tenant',
    profile: { email: 'user@example.com' },
    provisioning: [{ targetSystem: 'entra-id' }],
  };

  /** The subject's linked admin identities (find by parentIdentityId); none unless a test sets. */
  let linkedAdmins: unknown[] = [];
  const mockIdentityModel = {
    findById: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockIdentity),
      }),
    }),
    find: jest.fn(() => ({ lean: () => ({ exec: async () => linkedAdmins }) })),
  };

  const createFindModel = (data: any[] = []) => ({
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(data),
        }),
      }),
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(data),
      }),
    }),
  });

  const mockUserEventModel = createFindModel([{ type: 'LOGIN', timestamp: new Date() }]);
  const mockAuditEventModel = createFindModel([{ action: 'UPDATE', timestamp: new Date() }]);
  const mockReviewItemModel = createFindModel([{ status: 'approved' }]);
  const mockReviewExclusionModel = createFindModel([
    { targetSystem: 'github', scope: 'account', status: 'active' },
  ]);
  const mockEntitlementCatalogModel = createFindModel([{ name: 'ReadAll' }, { name: 'Other' }]);
  /** The subject's access as the identity page lists it (GET /identity/:id/entitlements). */
  const held = [
    {
      id: 'policy:Staff:entra-id:group:ReadAll',
      entitlement: 'ReadAll',
      type: 'group',
      source: 'Staff',
      targetSystem: 'entra-id',
      grantedBy: 'policy',
      status: 'Active',
    },
  ];
  const mockEntitlements = {
    getEntitlements: jest.fn().mockResolvedValue({ identityId: 'id-1', entitlements: held }),
  };

  /** The subject's consent records as ConsentService lists them (expiry marked on read). */
  const consentRecords = [
    {
      _id: 'c-1',
      tenantId: 'test-tenant',
      identityId: 'id-1',
      purpose: 'analytics',
      status: 'revoked',
      grantedAt: new Date('2025-01-01T00:00:00Z'),
      revokedAt: new Date('2025-06-01T00:00:00Z'),
      expiresAt: new Date('2026-01-01T00:00:00Z'),
      grantedBy: 'dpo@example.com',
      method: 'web-form',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-06-01T00:00:00Z'),
      __v: 0,
    },
  ];
  const mockConsents = { listConsents: jest.fn().mockResolvedValue(consentRecords) };

  /** The subject's documents in the erasure scope's collections, by model name. */
  let scopeData: Record<string, unknown[]> = {};
  const scopeModels: Record<string, ReturnType<typeof createFindModel>> = {};
  const mockConnection = {
    models: {},
    model: jest.fn((name: string) => {
      scopeModels[name] = createFindModel(scopeData[name] ?? []);
      return scopeModels[name];
    }),
  };

  beforeEach(async () => {
    auditService = {
      logFireAndForget: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        DsarExportService,
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
        { provide: getModelToken('UserEvent'), useValue: mockUserEventModel },
        { provide: getModelToken('AuditEvent'), useValue: mockAuditEventModel },
        { provide: getModelToken('ReviewItem'), useValue: mockReviewItemModel },
        { provide: getModelToken('ReviewExclusion'), useValue: mockReviewExclusionModel },
        { provide: getModelToken('EntitlementCatalog'), useValue: mockEntitlementCatalogModel },
        { provide: IdentityEntitlementsService, useValue: mockEntitlements },
        { provide: ConsentService, useValue: mockConsents },
        { provide: AuditService, useValue: auditService },
        { provide: getConnectionToken(), useValue: mockConnection },
      ],
    }).compile();

    service = module.get<DsarExportService>(DsarExportService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    scopeData = {};
    linkedAdmins = [];
  });

  describe('exportIdentityData', () => {
    it('should return complete export package', async () => {
      const result = await service.exportIdentityData('id-1', 'admin-1');

      expect(result).toEqual({
        exportedAt: expect.any(String),
        exportedBy: 'admin-1',
        dataSubjectId: 'id-1',
        identity: mockIdentity,
        timeline: [{ type: 'LOGIN', timestamp: expect.any(Date) }],
        auditTrail: [{ action: 'UPDATE', timestamp: expect.any(Date) }],
        accessReviews: [{ status: 'approved' }],
        accessReviewExclusions: [{ targetSystem: 'github', scope: 'account', status: 'active' }],
        entitlements: held,
        consents: [
          {
            purpose: 'analytics',
            status: 'revoked',
            grantedAt: consentRecords[0].grantedAt,
            revokedAt: consentRecords[0].revokedAt,
            expiresAt: consentRecords[0].expiresAt,
            method: 'web-form',
          },
        ],
        // HX-G3: every other collection of the erasure scope, empty for this subject
        records: expect.objectContaining({ credential_inventory: [], access_requests: [] }),
        linkedAdminIdentities: [],
        attestation: expect.stringContaining('Article 15'),
      });
      // Each section is read for the subject only
      expect(mockIdentityModel.findById).toHaveBeenCalledWith('id-1');
      expect(mockUserEventModel.find).toHaveBeenCalledWith({ userId: 'id-1' });
      expect(mockAuditEventModel.find).toHaveBeenCalledWith({ resourceId: 'id-1' });
      expect(mockReviewItemModel.find).toHaveBeenCalledWith({ identityId: 'id-1' });
      // Hunt 06 F8: the subject's own access, not the catalog of the systems they are in (or,
      // without provisioning, the tenant's whole catalog)
      expect(mockEntitlements.getEntitlements).toHaveBeenCalledWith('id-1');
      expect(mockEntitlementCatalogModel.find).not.toHaveBeenCalled();
    });

    it('exports no entitlements for a subject who holds none', async () => {
      mockEntitlements.getEntitlements.mockResolvedValueOnce(null);

      const result = await service.exportIdentityData('id-1', 'admin-1');

      expect(result.entitlements).toEqual([]);
    });

    // HX-G follow-up: the package left out the subject's consent records (GDPR_COMPLIANCE.md
    // marked the export Partial for it)
    it("includes the subject's consent records, and counts them in the audit entry", async () => {
      const result = await service.exportIdentityData('id-1', 'admin-1');

      expect(mockConsents.listConsents).toHaveBeenCalledWith('id-1');
      expect(result.consents).toHaveLength(1);
      expect(auditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { metadata: expect.objectContaining({ consentCount: 1 }) },
        }),
      );
    });

    it("includes the subject's access review exclusions", async () => {
      const result = await service.exportIdentityData('id-1', 'admin-1');

      expect(mockReviewExclusionModel.find).toHaveBeenCalledWith({ identityId: 'id-1' });
      expect(result.accessReviewExclusions).toEqual([
        { targetSystem: 'github', scope: 'account', status: 'active' },
      ]);
    });

    it('should throw NotFoundException when identity not found', async () => {
      mockIdentityModel.findById.mockReturnValueOnce({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(service.exportIdentityData('nonexistent', 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should call auditService.logFireAndForget with DATA_EXPORTED', async () => {
      await service.exportIdentityData('id-1', 'admin-1');

      expect(auditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DATA_EXPORTED',
        }),
      );
    });

    it('should include correct attestation string', async () => {
      const result = await service.exportIdentityData('id-1', 'admin-1');

      expect(result.attestation).toBeDefined();
      expect(typeof result.attestation).toBe('string');
      expect(result.attestation).toContain('Article 15');
    });
  });

  // HX-G3: the export left out records the erasure deletes as the person's (credential
  // inventory, risk scores, anomalies, JML records, drifts, access requests), so the Art. 15
  // package was incomplete. It now covers the erasure scope, read from gdpr-erasure-scope.ts.
  describe('the erasure scope', () => {
    it("exports every collection a GDPR erasure reaches, read with the erasure's filter", async () => {
      const result = await service.exportIdentityData('id-1', 'admin-1');

      for (const target of ERASURE_TARGETS) {
        if (target.dsar === 'consents') {
          expect(result.consents).toBeDefined();
          continue;
        }
        expect(result.records).toHaveProperty(target.collection);
        expect(scopeModels[target.model].find).toHaveBeenCalledWith(
          target.filter('test-tenant', 'id-1'),
        );
      }
      expect(Object.keys(result.records).sort()).toEqual(
        ERASURE_TARGETS.filter((t) => t.dsar !== 'consents')
          .map((t) => t.collection)
          .sort(),
      );
    });

    it("gives the subject's records without another person's data, and counts them", async () => {
      scopeData = {
        Anomaly: [
          {
            tenantId: 'test-tenant',
            anomalyId: 'a-1',
            identityId: 'id-1',
            title: 'Changes out of hours',
            acknowledgedBy: 'soc@example.com',
            evidence: {
              pattern: 'off-hours',
              details: { count: 2, actors: ['admin@example.com'] },
            },
          },
        ],
        CredentialInventory: [
          {
            tenantId: 'test-tenant',
            identityId: 'id-1',
            targetSystem: 'entra-id',
            mfa: { enrolled: true, methods: ['authenticator'] },
          },
        ],
      };

      const result = await service.exportIdentityData('id-1', 'admin-1');

      expect(result.records.anomalies).toEqual([
        {
          anomalyId: 'a-1',
          identityId: 'id-1',
          title: 'Changes out of hours',
          evidence: { pattern: 'off-hours', details: { count: 2 } },
        },
      ]);
      expect(result.records.credential_inventory).toEqual([
        {
          identityId: 'id-1',
          targetSystem: 'entra-id',
          mfa: { enrolled: true, methods: ['authenticator'] },
        },
      ]);
      expect(auditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            metadata: expect.objectContaining({
              recordCounts: expect.objectContaining({ anomalies: 1, credential_inventory: 1 }),
            }),
          },
        }),
      );
    });
  });

  // HX-G3: an erasure erases the person's linked admin identities with them (HX-G2), so the
  // export covers them too
  it('exports each linked admin identity with the same sections', async () => {
    linkedAdmins = [
      {
        _id: 'adm-1',
        parentIdentityId: 'id-1',
        adminTier: 'TIER_1',
        profile: { email: 'adm-u@x' },
      },
    ];

    const result = await service.exportIdentityData('id-1', 'admin-1');

    expect(mockIdentityModel.find).toHaveBeenCalledWith({ parentIdentityId: 'id-1' });
    expect(result.linkedAdminIdentities).toHaveLength(1);
    expect(result.linkedAdminIdentities[0]).toMatchObject({
      identity: { _id: 'adm-1', adminTier: 'TIER_1' },
      timeline: expect.any(Array),
      records: expect.objectContaining({ access_requests: [] }),
    });
    expect(mockUserEventModel.find).toHaveBeenCalledWith({ userId: 'adm-1' });
    expect(auditService.logFireAndForget).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { metadata: expect.objectContaining({ linkedAdminIdentityCount: 1 }) },
      }),
    );
  });
});
