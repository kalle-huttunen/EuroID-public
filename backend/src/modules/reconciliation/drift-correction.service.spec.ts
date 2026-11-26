/**
 * Unit tests for DriftCorrectionService.
 *
 * Validates correction logic for each drift type:
 * - FIELD_MISMATCH triggers Entra provisioning (update)
 * - MISSING_USER triggers user creation in target system
 * - ORPHAN_ACCOUNT returns skipConnector=true without calling connector
 * - Failed corrections return success=false with error message
 * - STATUS_MISMATCH triggers enable/disable based on hub user status
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DriftCorrectionService, CorrectionResult } from './drift-correction.service';
import { IdentityService } from '../identity/identity.service';
import { EntraActivities } from '../../activities/entra.activities';
import { createMockIdentityDocument } from '@testing/mock-factories';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { DriftDocument } from './schemas/drift.schema';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { AdService } from '../connectors/ad-connector/ad.service';
import { SCIMService } from '../connectors/scim-connector/scim.service';
import { ConnectorConfigService } from '../connectors/connector-config.service';

// ── Mock tenant context ──────────────────────────────────────────────
// withTenantContext simply runs the callback; no AsyncLocalStorage needed in unit tests.
jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  withTenantContext: (_tenantId: string, fn: () => unknown) => fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a minimal DriftDocument-like object for testing. */
function createDriftDoc(overrides: Partial<DriftDocument> = {}): DriftDocument {
  return {
    _id: 'drift-001',
    tenantId: TEST_TENANT_ID,
    type: 'FIELD_MISMATCH',
    severity: 'medium',
    userId: 'identity-001',
    userDisplayName: 'John Doe',
    userEmail: 'john.doe@example.com',
    targetSystem: 'entra-id',
    field: 'jobTitle',
    hubValue: 'Senior Engineer',
    targetValue: 'Engineer',
    detectedAt: new Date(),
    autoCorrectEligible: true,
    status: 'open',
    ...overrides,
  } as unknown as DriftDocument;
}

describe('DriftCorrectionService', () => {
  let service: DriftCorrectionService;
  let identityService: jest.Mocked<Pick<IdentityService, 'findUserForReconciliation'>>;
  let entraActivities: jest.Mocked<
    Pick<EntraActivities, 'provisionUserToEntra' | 'disableEntraUser' | 'enableEntraUser'>
  >;
  let adService: { getUserByEmail: jest.Mock; setUserEnabled: jest.Mock };
  let connectorConfig: { getConfig: jest.Mock };

  beforeEach(async () => {
    adService = { getUserByEmail: jest.fn(), setUserEnabled: jest.fn() };
    connectorConfig = { getConfig: jest.fn().mockResolvedValue(null) };
    identityService = {
      findUserForReconciliation: jest.fn(),
    };

    entraActivities = {
      provisionUserToEntra: jest.fn(),
      disableEntraUser: jest.fn(),
      enableEntraUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriftCorrectionService,
        { provide: IdentityService, useValue: identityService },
        { provide: EntraActivities, useValue: entraActivities },
        { provide: AdService, useValue: adService },
        { provide: SCIMService, useValue: { setActive: jest.fn() } },
        { provide: ConnectorConfigService, useValue: connectorConfig },
      ],
    }).compile();

    service = module.get<DriftCorrectionService>(DriftCorrectionService);
  });

  // ── 1. FIELD_MISMATCH ────────────────────────────────────────────

  describe('executeCorrection — FIELD_MISMATCH', () => {
    it('should trigger Entra provisioning to correct field drift', async () => {
      const identity = createMockIdentityDocument();
      identityService.findUserForReconciliation.mockResolvedValue(identity);
      entraActivities.provisionUserToEntra.mockResolvedValue({
        success: true,
        objectId: 'entra-object-id',
        skipped: false,
      });

      const drift = createDriftDoc({
        type: 'FIELD_MISMATCH',
        targetSystem: 'entra-id',
        field: 'jobTitle',
        hubValue: 'Senior Engineer',
        targetValue: 'Engineer',
      });

      const result: CorrectionResult = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(true);
      expect(result.skipConnector).toBe(false);
      expect(result.error).toBeUndefined();
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledTimes(1);
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'john.doe@example.com' }),
        undefined,
        undefined,
        TEST_TENANT_ID,
      );
    });

    it('should return error when target system is not entra-id', async () => {
      const identity = createMockIdentityDocument();
      identityService.findUserForReconciliation.mockResolvedValue(identity);

      const drift = createDriftDoc({
        type: 'FIELD_MISMATCH',
        targetSystem: 'active-directory',
      });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(false);
      expect(result.skipConnector).toBe(false);
      expect(result.error).toContain('Field correction not supported');
      expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
    });
  });

  // ── 2. MISSING_USER ──────────────────────────────────────────────

  describe('executeCorrection — MISSING_USER', () => {
    it('should trigger user creation in Entra when user is missing from target', async () => {
      const identity = createMockIdentityDocument();
      identityService.findUserForReconciliation.mockResolvedValue(identity);
      entraActivities.provisionUserToEntra.mockResolvedValue({
        success: true,
        objectId: 'new-entra-id',
        skipped: false,
      });

      const drift = createDriftDoc({
        type: 'MISSING_USER',
        targetSystem: 'entra-id',
      });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(true);
      expect(result.skipConnector).toBe(false);
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledTimes(1);
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'john.doe@example.com',
          firstName: 'John',
          lastName: 'Doe',
        }),
        undefined,
        undefined,
        TEST_TENANT_ID,
      );
    });

    it('should return user-not-found error when identity is missing from hub', async () => {
      identityService.findUserForReconciliation.mockResolvedValue(null);

      const drift = createDriftDoc({ type: 'MISSING_USER' });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain('User not found');
      expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
    });

    // The reason reaches the API answer (400 Correction failed: ...) and the bulk failures
    it('names the missing identity by its id, never the email', async () => {
      identityService.findUserForReconciliation.mockResolvedValue(null);

      const result = await service.executeCorrection(
        createDriftDoc({ type: 'MISSING_USER' }),
        TEST_TENANT_ID,
      );

      expect(result.error).toBe('User not found: identity identity-001');
      expect(result.error).not.toContain('john.doe@example.com');
    });

    it("finds the user by the drift's identity id first", async () => {
      identityService.findUserForReconciliation.mockResolvedValue(createMockIdentityDocument());
      entraActivities.provisionUserToEntra.mockResolvedValue({ success: true } as never);

      await service.executeCorrection(createDriftDoc({ type: 'MISSING_USER' }), TEST_TENANT_ID);

      expect(identityService.findUserForReconciliation).toHaveBeenCalledTimes(1);
      expect(identityService.findUserForReconciliation).toHaveBeenCalledWith('identity-001');
    });

    it('still corrects an older drift whose userId is not an identity key, by its email', async () => {
      identityService.findUserForReconciliation.mockImplementation(async (key: string) =>
        key === 'john.doe@example.com' ? createMockIdentityDocument() : null,
      );
      entraActivities.provisionUserToEntra.mockResolvedValue({ success: true } as never);

      const result = await service.executeCorrection(
        createDriftDoc({ type: 'MISSING_USER', userId: 'legacy-key' }),
        TEST_TENANT_ID,
      );

      expect(result.success).toBe(true);
      expect(identityService.findUserForReconciliation).toHaveBeenCalledWith('legacy-key');
      expect(identityService.findUserForReconciliation).toHaveBeenCalledWith(
        'john.doe@example.com',
      );
    });
  });

  // ── 3. ORPHAN_ACCOUNT ────────────────────────────────────────────

  describe('executeCorrection — ORPHAN_ACCOUNT', () => {
    it('should return skipConnector=true without calling any connector', async () => {
      const drift = createDriftDoc({
        type: 'ORPHAN_ACCOUNT',
        targetSystem: 'entra-id',
      });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(true);
      expect(result.skipConnector).toBe(true);
      expect(result.error).toBeUndefined();

      // No connector or identity calls should be made for orphan accounts
      expect(identityService.findUserForReconciliation).not.toHaveBeenCalled();
      expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
      expect(entraActivities.disableEntraUser).not.toHaveBeenCalled();
      expect(entraActivities.enableEntraUser).not.toHaveBeenCalled();
    });
  });

  // ── 4. Failed correction ─────────────────────────────────────────

  describe('executeCorrection — failure handling', () => {
    it('should return success=false with error message when connector throws', async () => {
      const identity = createMockIdentityDocument();
      identityService.findUserForReconciliation.mockResolvedValue(identity);
      entraActivities.provisionUserToEntra.mockRejectedValue(
        new Error('Entra API: 503 Service Unavailable'),
      );

      const drift = createDriftDoc({
        type: 'FIELD_MISMATCH',
        targetSystem: 'entra-id',
      });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(false);
      expect(result.skipConnector).toBe(false);
      expect(result.error).toBe('Entra API: 503 Service Unavailable');
    });

    it('should handle non-Error thrown values gracefully', async () => {
      const identity = createMockIdentityDocument();
      identityService.findUserForReconciliation.mockResolvedValue(identity);
      entraActivities.provisionUserToEntra.mockRejectedValue('string error');

      const drift = createDriftDoc({
        type: 'FIELD_MISMATCH',
        targetSystem: 'entra-id',
      });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });

    it('should return error for unsupported drift type on non-entra system', async () => {
      const identity = createMockIdentityDocument();
      identityService.findUserForReconciliation.mockResolvedValue(identity);

      // Unknown type maps to FIELD_MISMATCH (fallback in toSystemDrift),
      // which returns an error for non-entra systems
      const drift = createDriftDoc({
        type: 'UNKNOWN_TYPE' as any,
        targetSystem: 'some-other-system',
      });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Field correction not supported');
    });

    // 2.0dt: these came back as success=false with no error, so single Correct answered
    // "Correction failed: Unknown error" and bulk correction logged "undefined".
    it('names the system when it cannot correct this drift type there', async () => {
      identityService.findUserForReconciliation.mockResolvedValue(createMockIdentityDocument());

      const result = await service.executeCorrection(
        createDriftDoc({ type: 'MISSING_USER', targetSystem: 'okta' }),
        TEST_TENANT_ID,
      );

      expect(result).toEqual({
        success: false,
        skipConnector: false,
        error: 'Correction of MISSING_USER is not supported for system: okta',
      });
      expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
    });

    it('says the user was not found in Entra ID when enabling finds no account', async () => {
      identityService.findUserForReconciliation.mockResolvedValue(createMockIdentityDocument());
      entraActivities.enableEntraUser.mockResolvedValue(false);
      entraActivities.disableEntraUser.mockResolvedValue(false);

      const result = await service.executeCorrection(
        createDriftDoc({ type: 'STATUS_MISMATCH', targetSystem: 'entra-id' }),
        TEST_TENANT_ID,
      );

      expect(result).toEqual({
        success: false,
        skipConnector: false,
        error: 'The user was not found in entra-id',
      });
    });
  });

  // ── 5. STATUS_MISMATCH ───────────────────────────────────────────

  describe('executeCorrection — STATUS_MISMATCH', () => {
    it('should enable Entra user when hub status is ACTIVE', async () => {
      const identity = createMockIdentityDocument({
        profile: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john.doe@example.com',
          status: UserStatus.ACTIVE,
          departmentName: 'Engineering',
        },
      });
      identityService.findUserForReconciliation.mockResolvedValue(identity);
      entraActivities.enableEntraUser.mockResolvedValue(true);

      const drift = createDriftDoc({
        type: 'STATUS_MISMATCH',
        targetSystem: 'entra-id',
        hubValue: 'ACTIVE',
        targetValue: 'DISABLED',
      });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(true);
      expect(result.skipConnector).toBe(false);
      expect(entraActivities.enableEntraUser).toHaveBeenCalledWith(
        'john.doe@example.com',
        TEST_TENANT_ID,
      );
      expect(entraActivities.disableEntraUser).not.toHaveBeenCalled();
    });

    it('should disable Entra user when hub status is not ACTIVE', async () => {
      const identity = createMockIdentityDocument({
        profile: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john.doe@example.com',
          status: UserStatus.SUSPENDED,
          departmentName: 'Engineering',
        },
      });
      identityService.findUserForReconciliation.mockResolvedValue(identity);
      entraActivities.disableEntraUser.mockResolvedValue(true);

      const drift = createDriftDoc({
        type: 'STATUS_MISMATCH',
        targetSystem: 'entra-id',
        hubValue: 'SUSPENDED',
        targetValue: 'ACTIVE',
      });

      const result = await service.executeCorrection(drift, TEST_TENANT_ID);

      expect(result.success).toBe(true);
      expect(result.skipConnector).toBe(false);
      expect(entraActivities.disableEntraUser).toHaveBeenCalledWith(
        'john.doe@example.com',
        TEST_TENANT_ID,
      );
      expect(entraActivities.enableEntraUser).not.toHaveBeenCalled();
    });

    // The state provisioning writes for the hub status (targetAccountEnabled): a PENDING
    // joiner's account is created enabled, so Correct enables it, never disables it.
    it('enables the account of a PENDING identity', async () => {
      identityService.findUserForReconciliation.mockResolvedValue(
        createMockIdentityDocument({
          profile: { firstName: 'John', email: 'john.doe@example.com', status: UserStatus.PENDING },
        }),
      );
      entraActivities.enableEntraUser.mockResolvedValue(true);

      const result = await service.executeCorrection(
        createDriftDoc({ type: 'STATUS_MISMATCH', hubValue: 'ENABLED', targetValue: 'DISABLED' }),
        TEST_TENANT_ID,
      );

      expect(result.success).toBe(true);
      expect(entraActivities.enableEntraUser).toHaveBeenCalled();
      expect(entraActivities.disableEntraUser).not.toHaveBeenCalled();
    });

    it("disables a leaver's AD account by the DN of the account found by the email", async () => {
      identityService.findUserForReconciliation.mockResolvedValue(
        createMockIdentityDocument({
          profile: { email: 'john.doe@example.com', status: UserStatus.TERMINATED },
        }),
      );
      connectorConfig.getConfig.mockResolvedValue({
        config: { host: 'dc.corp.example', rootBaseDn: 'DC=corp,DC=example' },
      });
      adService.getUserByEmail.mockResolvedValue({ id: 'CN=John Doe,DC=corp,DC=example' });
      adService.setUserEnabled.mockResolvedValue({ outcome: 'done', detail: 'disabled' });

      const result = await service.executeCorrection(
        createDriftDoc({ type: 'STATUS_MISMATCH', targetSystem: 'ad', hubValue: 'DISABLED' }),
        TEST_TENANT_ID,
      );

      expect(result).toEqual({ success: true, skipConnector: false });
      expect(adService.setUserEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'dc.corp.example' }),
        'CN=John Doe,DC=corp,DC=example',
        false,
      );
    });
  });
});
