/**
 * The identities a campaign reviews: its scope (all, a department, a role by job title, the
 * people provisioned in one system) and its target employment types (default: the human types).
 */
import type { IdentityService } from '../identity/identity.service';
import type { ProvisioningState, LinkedAccount } from '../identity/schemas/identity.schema';
import type { ReviewCampaignDocument } from './schemas/review-campaign.schema';
import { provisionedInScope } from './review-campaign-scope';

/** Projected identity shape returned by IdentityService.findAll / campaignIdentities. */
export interface ProjectedIdentity {
  _id?: string;
  email: string;
  firstName?: string;
  lastName?: string;
  departmentName?: string;
  departmentCode?: string;
  managerEmail?: string;
  managerId?: string;
  employmentType?: string;
  jobTitle?: string;
  provisioning?: ProvisioningState[];
  sources?: LinkedAccount[];
  createdBy?: string;
  [key: string]: unknown;
}

export async function campaignIdentities(
  identityService: IdentityService,
  campaign: ReviewCampaignDocument,
): Promise<ProjectedIdentity[]> {
  const scope = campaign.scope;
  const targetTypes = campaign.targetEmploymentTypes ?? [
    'FULL_TIME',
    'PART_TIME',
    'CONTRACTOR',
    'INTERN',
    'CONSULTANT',
  ];
  // Sources: machine accounts' token or admin record, and the target account records
  // (written-back account ids) the review gathers access from; provisioning: the accounts in
  // targets without readable memberships
  const options = {
    employmentTypes: targetTypes,
    includeSources: true,
    includeProvisioning: true,
  };

  if (scope.type === 'system' && scope.value) {
    const identities = await identityService.findIdentitiesForOnboarding();
    const filtered = identities.filter((id) => provisionedInScope(id, scope.value!));
    return filtered
      .filter((id) => !targetTypes.length || targetTypes.includes(id.profile?.employmentType || ''))
      .map(
        (id): ProjectedIdentity => ({
          ...(id.profile || {}),
          _id: id._id?.toString(),
          email: id.profile?.email ?? '',
          firstName: id.profile?.firstName,
          lastName: id.profile?.lastName,
          departmentName: id.profile?.departmentName,
          departmentCode: id.profile?.departmentCode,
          managerEmail: id.profile?.managerEmail,
          managerId: id.profile?.managerId,
          provisioning: id.provisioning,
          employmentType: id.profile?.employmentType,
          sources: id.sources,
        }),
      );
  }

  const all = (await identityService.findAll(options)) as ProjectedIdentity[];
  if (scope.type === 'all') return all;

  if (scope.type === 'department' && scope.value) {
    return all.filter(
      (u) =>
        String(u.departmentName || '').toLowerCase() === scope.value!.toLowerCase() ||
        String(u.departmentCode || '').toLowerCase() === scope.value!.toLowerCase(),
    );
  }

  if (scope.type === 'role' && scope.value) {
    return all.filter((u) =>
      String(u.jobTitle || '')
        .toLowerCase()
        .includes(scope.value!.toLowerCase()),
    );
  }

  return all;
}
