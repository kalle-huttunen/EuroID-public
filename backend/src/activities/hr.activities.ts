import { Injectable, Logger } from '@nestjs/common';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import { IdentityService } from '../modules/identity/identity.service';
import type { IdentityDocument } from '../modules/identity/schemas/identity.schema';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { HR_FETCH_PAGE_SIZE } from '@infrastructure/config/defaults';
import { maskEmail } from '../modules/identity/identity-pii';

/**
 * [ACTIVITIES] HR Connector (Source & Write-Back)
 * -----------------------------------------------
 * RESPONSIBILITY:
 * - Inbound: Fetch users from the Identity Hub that need onboarding
 * - Outbound: Push generated attributes (e.g., work email) back to the HR system
 *
 * Multi-HR: Prefers Identity (Onion) with primary HR source; write-back targets primary HR only.
 */
@Injectable()
export class HrActivities {
  private readonly logger = new Logger(HrActivities.name);

  constructor(private readonly identityService: IdentityService) {}

  /**
   * Push generated work email back to the primary HR system.
   * Called after provisioning to an Email Authoritative connector (Entra, AD).
   *
   * @param sourceUserId - HR system ID (e.g., Workday worker ID), typically from metadata.primaryContractExternalId
   * @param workEmail - The generated work email from Entra/AD
   * @param primaryHrSource - Optional sourceName (e.g. 'workday') for multi-HR; used to route write-back
   */
  async writeBackToHr(
    sourceUserId: string,
    workEmail: string,
    primaryHrSource?: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        this.logger.log(
          `[HrActivities] Write-back: sourceUserId=${sourceUserId}, workEmail=${maskEmail(workEmail)}, primaryHr=${primaryHrSource ?? 'default'}`,
        );
        // TODO: When HR API supports write (e.g., Workday PATCH /workers/{id}), implement getHrClientForSource + patchWorker. See MULTI_HR_INGESTION_PLAN.md.
        return { success: true };
      },
      { correlationId },
    );
  }

  /**
   * Fetches users from the Identity Hub for onboarding (multi-HR aware).
   * Prefers Identity (Onion) model when available; falls back to User model for legacy.
   */
  async fetchNewHires(tenantId?: string, correlationId?: string): Promise<StandardUserDto[]> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        this.logger.log('Fetching users from Identity Hub for onboarding...');

        let skip = 0;
        const identities: IdentityDocument[] = [];
        let batch: IdentityDocument[];
        do {
          batch = await this.identityService.findIdentitiesForOnboardingPaginated(
            skip,
            HR_FETCH_PAGE_SIZE,
          );
          identities.push(...batch);
          skip += HR_FETCH_PAGE_SIZE;
        } while (batch.length === HR_FETCH_PAGE_SIZE);

        if (identities.length > 0) {
          this.logger.log(`Found ${identities.length} identities (Onion model) for onboarding.`);
          return identities.map((identity) => this.identityToDto(identity));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- findAllPaginated returns Mongoose lean docs with dynamic shape
        const users: Record<string, any>[] = [];
        let total = 0;
        skip = 0;
        do {
          const [batch, pageTotal] = await this.identityService.findAllPaginated(
            skip,
            skip + HR_FETCH_PAGE_SIZE,
          );
          if (skip === 0) total = pageTotal;
          users.push(...batch);
          skip += HR_FETCH_PAGE_SIZE;
        } while (skip < total);
        this.logger.log(`Found ${users.length} users (legacy) for onboarding.`);
        return users.map((user) => ({
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          departmentCode: user.departmentCode,
          location: user.location,
          status: user.status || UserStatus.ACTIVE,
          tenantId: user.tenantId || 'root',
          sourceSystem: user.sourceSystem,
          sourceUserId: user.sourceUserId,
        })) as StandardUserDto[];
      },
      { correlationId },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IdentityDocument profile is a dynamic Mongoose sub-document
  private identityToDto(identity: any): StandardUserDto {
    const p = identity.profile || {};
    const primary = identity.metadata?.primaryHrSource
      ? identity.sources?.find(
          (s: { sourceName: string }) => s.sourceName === identity.metadata?.primaryHrSource,
        )
      : identity.sources?.[0];
    return {
      email: p.email,
      firstName: p.firstName,
      lastName: p.lastName,
      departmentCode: p.departmentCode,
      departmentName: p.departmentName,
      jobTitle: p.jobTitle,
      location: p.location,
      status: p.status || UserStatus.ACTIVE,
      tenantId: p.tenantId || 'root',
      sourceSystem: primary?.sourceName || p.sourceSystem || 'hr-feed',
      sourceUserId:
        identity.metadata?.primaryContractExternalId ??
        primary?.externalId ??
        p.sourceUserId ??
        p.email,
    } as StandardUserDto;
  }
}
