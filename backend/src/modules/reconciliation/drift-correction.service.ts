/**
 * Drift Correction Service
 *
 * Performs actual correction in target systems when an operator requests drift correction via
 * the API: a STATUS_MISMATCH in Entra ID, AD or SCIM (the enabled state provisioning writes for
 * the hub status), the other types in Entra ID. RC-1 remediation: ensures status update
 * is accompanied by real connector calls, not just marking as corrected.
 */

import { Injectable, Logger } from '@nestjs/common';
import { DriftDocument } from './schemas/drift.schema';
import { IdentityService } from '../identity/identity.service';
import { EntraActivities } from '../../activities/entra.activities';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import { SystemDrift, DriftType } from '@shared/dtos/distributed-transaction.dto';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { targetAccountEnabled } from '@shared/utils/linked-admin-profile';
import { AdService } from '../connectors/ad-connector/ad.service';
import { SCIMService } from '../connectors/scim-connector/scim.service';
import { ConnectorConfigService } from '../connectors/connector-config.service';
import { setTargetAccountEnabled } from '../../activities/reconciliation-account-state';

export interface CorrectionResult {
  success: boolean;
  skipConnector: boolean; // true for ORPHAN_ACCOUNT — handled by workflow
  error?: string;
}

@Injectable()
export class DriftCorrectionService {
  private readonly logger = new Logger(DriftCorrectionService.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly entraActivities: EntraActivities,
    private readonly adService: AdService,
    private readonly scimService: SCIMService,
    private readonly connectorConfig: ConnectorConfigService,
  ) {}

  /**
   * Execute actual correction in target system for non-ORPHAN_ACCOUNT drifts.
   * ORPHAN_ACCOUNT is handled by orphan cleanup workflow; we only update status.
   */
  async executeCorrection(drift: DriftDocument, tenantId: string): Promise<CorrectionResult> {
    if (drift.type === 'ORPHAN_ACCOUNT') {
      return { success: true, skipConnector: true };
    }

    return withTenantContext(tenantId, async () => {
      // A drift's userId is the identity's _id; an older record's may be another key, so its
      // email is the fallback.
      const user =
        (await this.identityService.findUserForReconciliation(drift.userId)) ??
        (drift.userEmail
          ? await this.identityService.findUserForReconciliation(drift.userEmail)
          : null);
      if (!user) {
        this.logger.warn(
          `[DriftCorrection] User not found for drift ${drift._id}: identity ${drift.userId}`,
        );
        return {
          success: false,
          skipConnector: false,
          error: `User not found: identity ${drift.userId}`,
        };
      }

      const systemDrift = this.toSystemDrift(drift);
      const userDto = this.toStandardUserDto(user);

      try {
        let success = false;
        switch (systemDrift.driftType) {
          case DriftType.MISSING_USER:
            if (drift.targetSystem === 'entra-id') {
              const result = await this.entraActivities.provisionUserToEntra(
                userDto,
                undefined,
                undefined,
                tenantId,
              );
              success = result.success;
            }
            break;

          case DriftType.ORPHANED_USER:
            if (drift.targetSystem === 'entra-id') {
              success = await this.entraActivities.disableEntraUser(userDto.email, tenantId);
            }
            break;

          case DriftType.STATUS_MISMATCH: {
            // The state provisioning writes for the hub status, as detection expects it
            const outcome = await setTargetAccountEnabled(
              {
                entraActivities: this.entraActivities,
                adService: this.adService,
                scimService: this.scimService,
                connectorConfig: this.connectorConfig,
              },
              drift.targetSystem,
              userDto.email,
              targetAccountEnabled(userDto),
              tenantId,
            );
            if (outcome.success) return { success: true, skipConnector: false };
            if (drift.targetSystem !== 'entra-id') {
              return { success: false, skipConnector: false, error: outcome.error };
            }
            break;
          }

          case DriftType.FIELD_MISMATCH:
            if (drift.targetSystem === 'entra-id') {
              await this.entraActivities.provisionUserToEntra(
                userDto,
                undefined,
                undefined,
                tenantId,
              );
              success = true;
            } else {
              return {
                success: false,
                skipConnector: false,
                error: `Field correction not supported for system: ${drift.targetSystem}`,
              };
            }
            break;

          default:
            return {
              success: false,
              skipConnector: false,
              error: `Unsupported drift type: ${drift.type}`,
            };
        }

        if (success) return { success, skipConnector: false };
        // Entra ID answers false only when it has no account for the user; any other system
        // is one these drift types cannot be corrected in.
        return {
          success: false,
          skipConnector: false,
          error:
            drift.targetSystem === 'entra-id'
              ? 'The user was not found in entra-id'
              : `Correction of ${drift.type} is not supported for system: ${drift.targetSystem}`,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[DriftCorrection] Correction failed: ${message}`);
        return { success: false, skipConnector: false, error: message };
      }
    });
  }

  private toSystemDrift(drift: DriftDocument): SystemDrift {
    const typeMap: Record<string, DriftType> = {
      MISSING_USER: DriftType.MISSING_USER,
      ORPHANED_USER: DriftType.ORPHANED_USER,
      ORPHAN_ACCOUNT: DriftType.ORPHANED_USER, // Map for correction logic
      FIELD_MISMATCH: DriftType.FIELD_MISMATCH,
      STATUS_MISMATCH: DriftType.STATUS_MISMATCH,
      GROUP_MISMATCH: DriftType.GROUP_MISMATCH,
      LICENSE_MISMATCH: DriftType.LICENSE_MISMATCH,
    };
    return {
      system: drift.targetSystem,
      driftType: typeMap[drift.type] ?? DriftType.FIELD_MISMATCH,
      field: drift.field,
      expectedValue: drift.hubValue,
      actualValue: drift.targetValue,
      description: `${drift.type} in ${drift.targetSystem}`,
      severity: (drift.severity?.toUpperCase() ?? 'MEDIUM') as
        | 'LOW'
        | 'MEDIUM'
        | 'HIGH'
        | 'CRITICAL',
      autoCorrect: drift.autoCorrectEligible ?? false,
    };
  }

  private toStandardUserDto(user: Record<string, unknown>): StandardUserDto {
    if (user.profile) {
      const p = user.profile as Record<string, unknown>;
      const sources = user.sources as Array<Record<string, unknown>> | undefined;
      return {
        ...p,
        sourceSystem: p.sourceSystem ?? sources?.[0]?.sourceName ?? 'hr-feed',
        sourceUserId: p.sourceUserId ?? sources?.[0]?.externalId ?? p.email,
        tenantId: user.tenantId ?? p.tenantId ?? 'default',
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        status: (p.status as UserStatus) ?? UserStatus.ACTIVE,
        _id: (user._id as { toString(): string })?.toString(),
      } as StandardUserDto;
    }
    return {
      ...user,
      _id: (user._id as { toString(): string })?.toString(),
    } as StandardUserDto;
  }
}
