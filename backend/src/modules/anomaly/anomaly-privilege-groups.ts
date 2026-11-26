/**
 * The group changes the privilege escalation rule ranks, from an identity's provisioning
 * timeline. A change names the group as its target does, an Entra ID group by its object id (a
 * GUID, which no keyword ranks): each is resolved through the entitlement catalog
 * (catalog-target-lookup.ts) to its name there and the catalog's privilege marking
 * (catalogPrivilegeTier). A group the catalog does not know keeps its own id as its name.
 */
import type {
  CatalogTargetLookup,
  PolicyTarget,
} from '../entitlement-catalog/catalog-target-lookup';
import { catalogPrivilegeTier } from './anomaly-rules';

/** A USER_PROVISIONED timeline event, as far as the rule reads it. */
export interface ProvisioningTimelineEvent {
  _id?: { toString(): string } | string;
  timestamp: Date;
  targetSystem?: string;
  metadata?: unknown;
}

export interface PrivilegeGroupChanges {
  eventId: string;
  timestamp: Date;
  groupChanges: Array<{ groupName: string; action: 'add' | 'remove'; tier?: number }>;
}

/** The events with group changes, each group resolved through the catalog. */
export async function privilegeGroupChanges(
  events: ProvisioningTimelineEvent[],
  loadLookup: (targets: PolicyTarget[]) => Promise<CatalogTargetLookup>,
): Promise<PrivilegeGroupChanges[]> {
  const withGroups = events
    .map((e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      const rawOps = meta?.operations;
      const ops = (Array.isArray(rawOps) ? rawOps : []) as Array<Record<string, unknown>>;
      const system = String(e.targetSystem ?? '');
      return {
        eventId: e._id?.toString() || '',
        timestamp: e.timestamp,
        changes: ops
          .filter((o) => o.type === 'group')
          .map((o) => ({
            target: { system, targetId: (o.targetId as string) || '' },
            action: o.action === 'remove' ? ('remove' as const) : ('add' as const),
          })),
      };
    })
    .filter((e) => e.changes.length > 0);
  if (withGroups.length === 0) return [];

  const targets = withGroups.flatMap((e) =>
    e.changes.filter((c) => c.target.targetId).map((c) => c.target),
  );
  const lookup = await loadLookup(targets);
  return withGroups.map(({ eventId, timestamp, changes }) => ({
    eventId,
    timestamp,
    groupChanges: changes.map(({ target, action }) => {
      const entry = target.targetId ? lookup(target) : undefined;
      return entry
        ? { groupName: entry.name, action, tier: catalogPrivilegeTier(entry) }
        : { groupName: target.targetId, action };
    }),
  }));
}
