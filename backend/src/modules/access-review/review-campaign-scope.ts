/**
 * What a campaign scope of type `system` covers (pure). Every comparison uses systemKey, the
 * names the policy engine gives systems (`entra` is entra-id, `active-directory` is ad), so the
 * identities a campaign selects and the items it creates for them always name the same system.
 * Other scope types cover all access.
 */
import { BadRequestException } from '@nestjs/common';
import { systemKey } from '@shared/utils/normalize-system-name';
import type { ProvisioningState } from '../identity/schemas/identity.schema';
import type { CampaignScope } from './schemas/review-campaign.schema';
import type { ReviewEntitlement } from './schemas/review-item.schema';

/**
 * Scope `system` reviews only that system's access: its memberships, or the account item of a
 * target without readable memberships.
 */
export function inCampaignScope(entitlement: ReviewEntitlement, scope: CampaignScope): boolean {
  if (scope.type !== 'system' || !scope.value) return true;
  return systemKey(entitlement.system) === systemKey(scope.value);
}

/**
 * Scope `system` selects the identities provisioned to that system: `active-directory` selects
 * the ones provisioned to `ad`, and a part of a name (`file` for file-outbound) selects nobody.
 */
export function provisionedInScope(
  identity: { provisioning?: Array<Pick<ProvisioningState, 'targetSystem'>> },
  system: string,
): boolean {
  const key = systemKey(system);
  return (identity.provisioning ?? []).some((p) => systemKey(p.targetSystem) === key);
}

/**
 * Refuses (400) a `system` scope whose value names none of `knownSystems` (the connector ids of
 * the target systems) under any of its names: such a campaign would select nobody. The message
 * names the known systems.
 */
export function assertKnownSystem(scope: CampaignScope, knownSystems: string[]): void {
  if (scope.type !== 'system') return;
  const value = scope.value ?? '';
  if (value && knownSystems.some((id) => systemKey(id) === systemKey(value))) return;
  const known = [...knownSystems].sort().join(', ');
  throw new BadRequestException(
    `Scope system "${value}" is not a known system. Known systems: ${known}.`,
  );
}
