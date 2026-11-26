import { Injectable } from '@nestjs/common';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import type {
  CredentialState,
  MfaStatus,
} from '../modules/connectors/credential-management.interface';

/**
 * [ACTIVITIES] Credential Management Activities
 * -----------------------------------------------
 * Credential state reads from Entra ID and AD: last password change, account status, and the
 * Entra ID MFA methods. The nightly credential run's inventory refresh
 * (credential-inventory-refresh.ts) calls them. They reset no password.
 *
 * Connectors are dumb pipes; transient errors propagate to Temporal for automatic retry.
 */
@Injectable()
export class CredentialActivities {
  constructor(
    private readonly entraService: EntraService,
    private readonly adService: AdService,
  ) {}

  /**
   * Get credential state from Entra ID (password age, account status).
   * Used by credential rotation workflow to assess current state.
   */
  async getEntraCredentialState(
    externalId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<CredentialState> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      () => this.entraService.getCredentialState(externalId),
      { correlationId },
    );
  }

  /**
   * Get credential state from Active Directory (password age, UAC flags).
   * Used by credential rotation workflow to assess current state.
   */
  async getAdCredentialState(
    externalId: string,
    config?: AdConfig,
    tenantId?: string,
    correlationId?: string,
  ): Promise<CredentialState | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        if (!config?.host) return null;
        return this.adService.getCredentialState(config, externalId);
      },
      { correlationId },
    );
  }

  /**
   * Get MFA enrollment status from Entra ID.
   * Used by credential inventory updates.
   */
  async getEntraMfaStatus(
    externalId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<MfaStatus | null> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        if (!this.entraService.getMfaStatus) return null;
        return this.entraService.getMfaStatus(externalId);
      },
      { correlationId },
    );
  }
}
