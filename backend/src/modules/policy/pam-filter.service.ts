import { Injectable } from '@nestjs/common';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { catalogSystemName, normalizeSystemName } from '@shared/utils/normalize-system-name';
import type {
  PolicyProvisioningIntent,
  ProvisioningOperation,
  AdminOperation,
  AdminTier,
} from './policy-engine.service';
import {
  classifyByRid,
  classifyByTemplateId,
  WELL_KNOWN_AD_ADMIN_RIDS,
  WELL_KNOWN_ENTRA_ADMIN_ROLES,
} from './pam-classification';

// Re-export for backward compatibility
export { WELL_KNOWN_AD_ADMIN_RIDS, WELL_KNOWN_ENTRA_ADMIN_ROLES };

/**
 * PAM Filter: Splits provisioning operations into regular (daily-driver) and adminOperations (linked admin identity).
 * Tier 2: If PAM_TIER2_REQUIRES_ADMIN_ACCOUNT !== 'true', keep in regular operations.
 */
@Injectable()
export class PamFilterService {
  /** @deprecated Use classifyByRid() from pam-classification.ts directly */
  static classifyByRid = classifyByRid;

  /** @deprecated Use classifyByTemplateId() from pam-classification.ts directly */
  static classifyByTemplateId = classifyByTemplateId;

  constructor(private readonly entitlementCatalog: EntitlementCatalogService) {}

  /** Map policy target to catalog system name for PAM lookup (`all`: Entra ID). */
  private targetToCatalogSystem(target: string): string {
    if (normalizeSystemName(target) === 'all') return 'entra-id';
    return catalogSystemName(target);
  }

  /**
   * Apply PAM splitting: move admin-required entitlements to adminOperations.
   */
  async apply(
    intent: PolicyProvisioningIntent,
    tenantId: string,
  ): Promise<PolicyProvisioningIntent> {
    const tier2RequiresAdmin = process.env.PAM_TIER2_REQUIRES_ADMIN_ACCOUNT !== 'false';
    const operations: ProvisioningOperation[] = [];
    const adminOperations: AdminOperation[] = [];

    for (const op of intent.operations) {
      const system = this.targetToCatalogSystem(op.target);
      const catalogEntry = await this.entitlementCatalog.findForAdminRedirect(
        tenantId,
        system,
        op.targetId,
      );

      if (
        catalogEntry?.requiresAdminAccount &&
        (catalogEntry.adminTier !== 'TIER_2' || tier2RequiresAdmin)
      ) {
        adminOperations.push({ ...op, adminTier: catalogEntry.adminTier as AdminTier });
      } else {
        operations.push(op);
      }
    }

    return {
      operations,
      ...(adminOperations.length > 0 && { adminOperations }),
      ...(intent.sodWarnings && { sodWarnings: intent.sodWarnings }),
    };
  }
}
