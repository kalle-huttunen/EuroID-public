/**
 * Migration: report active role-based rules that have a condition group with no conditions.
 * It changes nothing.
 *
 * Before this release a condition group without conditions matched everyone (an AND of nothing
 * is true); from this release it matches nobody (PolicyEngineService.matchesConditions) and the
 * API refuses new ones. An active rule stored with such a group gave its access to every
 * identity and now gives it to none: onboarding, the mover and reconciliation may read the
 * missing access as a removal for every identity. The rule is not deactivated here (the operator
 * decides what it should match); this logs, per tenant, the id and name of each such rule, with
 * "Before the deploy" in docs/DEPLOYMENT.md asking the operator to review them. A rule with a
 * group whose `conditions` is missing or null counts as empty too. Rerunning it reports again.
 */
import { Db, ObjectId } from 'mongodb';

const POLICIES = 'policies';

interface PolicyRow {
  _id: ObjectId;
  tenantId?: string;
  name?: string;
}

/** Active rules with an empty condition group, by tenant: `{ tenantId: ['<id> (<name>)'] }`. */
export async function emptyConditionGroupPolicies(db: Db): Promise<Record<string, string[]>> {
  const rows = await db
    .collection<PolicyRow>(POLICIES)
    .find(
      {
        status: 'active',
        conditionGroups: {
          $elemMatch: { $or: [{ conditions: { $size: 0 } }, { conditions: null }] },
        },
      },
      { projection: { tenantId: 1, name: 1 } },
    )
    .toArray();
  const byTenant: Record<string, string[]> = {};
  for (const row of rows) {
    const tenant = row.tenantId ?? '(no tenant)';
    (byTenant[tenant] ??= []).push(`${row._id.toHexString()} (${row.name ?? 'unnamed'})`);
  }
  return byTenant;
}

export async function up(db: Db): Promise<void> {
  const byTenant = await emptyConditionGroupPolicies(db);
  const tenants = Object.keys(byTenant);
  if (tenants.length === 0) {
    console.log('[migration] policies: no active rule has a condition group without conditions');
    return;
  }
  for (const tenant of tenants) {
    console.warn(
      `[migration] policies: tenant ${tenant} has ${byTenant[tenant].length} active rule(s) ` +
        'with a condition group without conditions, which matched everyone and now match ' +
        `nobody; review them: ${byTenant[tenant].join(', ')}`,
    );
  }
}

/** `up` changes nothing, so there is nothing to undo. */
export async function down(): Promise<void> {}
