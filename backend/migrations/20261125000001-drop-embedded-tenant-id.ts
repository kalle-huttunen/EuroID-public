/**
 * Migration: embedded documents lose the tenantId the tenant plugin gave them.
 *
 * The tenant plugin is registered globally, and Mongoose applied it to every embedded schema too:
 * each got an indexed tenantId path, so Mongoose built indexes such as `sources.tenantId_1` and
 * `passwordPolicy.tenantId_1` that no query uses and every write maintains, and subdocuments were
 * stamped with the request's tenant (all of them before 2ae3a960; identity sources, controls and
 * provisioning entries since, through ensureTenantId). The API returned the stamped key. The
 * plugin now gives embedded schemas nothing (FOLLOWUPS 2026-11-25), and this removes what it left:
 *
 * 1. In every collection, each index whose key is a single nested `<path>.tenantId`, found with
 *    listIndexes. A top-level tenantId index and a compound index are never dropped. No model
 *    declares such an index any more, so Mongoose does not build them again.
 * 2. The stamped `tenantId` of the embedded documents the models declared at this release
 *    (EMBEDDED_PATHS), arrays included at any depth. `profile.tenantId` on identities is declared
 *    by IdentityProfile itself and stays; the dead-letter entry's `error` never had one.
 *
 * Counts are logged. A second run finds nothing to change.
 */
import type { Db, Document } from 'mongodb';

const LOG = '[drop-embedded-tenant-id]';

/**
 * The embedded schemas of each collection's model at this release (`[]`: an array of them), from
 * walking every model schema's embedded paths. Later models get no stamped tenantId: the plugin
 * no longer reaches embedded schemas.
 */
const EMBEDDED_PATHS: Record<string, string[]> = {
  access_requests: [
    'entitlements[]',
    'approvalSteps[]',
    'timeConstraint',
    'sodCheckResult',
    'sodCheckResult.violations[]',
  ],
  agent_identities: ['owner'],
  anomalies: ['evidence'],
  canvasblueprints: ['pipelineConfig'],
  compliance_report_metadata: ['dateRange', 'summary'],
  credential_inventory: ['password', 'mfa', 'passkeys', 'certificates[]'],
  credential_policies: ['targetScope', 'passwordPolicy', 'rotationPolicy', 'mfaRequirement'],
  drift_records: ['orphanDetails'],
  entitlement_catalog: ['approvalChain[]'],
  event_subscriptions: ['filters', 'webhook'],
  identities: ['sources[]', 'controls', 'provisioning[]', 'linkedAdminAccounts[]'],
  identity_risk_scores: ['factors[]', 'history[]'],
  peer_groups: ['attributes', 'entitlementBaseline[]', 'outliers[]'],
  policies: ['conditionGroups[]', 'conditionGroups[].conditions[]', 'actions[]'],
  policy_suggestions: [
    'suggestedPolicy',
    'suggestedPolicy.conditionGroups[]',
    'suggestedPolicy.conditionGroups[].conditions[]',
    'suggestedPolicy.actions[]',
    'evidence',
  ],
  review_campaigns: ['scope', 'stats', 'revocationSummary', 'recurrence', 'escalation'],
  review_exclusions: ['grantingPolicies[]'],
  review_items: ['entitlements[]', 'entitlements[].revocation'],
  reviewer_quality_scores: ['signals'],
  role_bundles: ['actions[]'],
  sod_policies: ['conflictingEntitlements[]'],
  upcoming_offboardings: ['blastRadius', 'blastRadius.entitlements[]'],
};

interface UnsetStep {
  filter: Document;
  update: Document;
  arrayFilters?: Document[];
}

/**
 * The update that removes `tenantId` from the embedded documents at `spec`. Each array goes
 * through a filtered positional operator, so an element without the next part of the path (a
 * group without conditions, a null) is left alone instead of failing the update.
 */
export function unsetStep(spec: string): UnsetStep {
  const segments = spec
    .split('.')
    .map((s) => ({ name: s.replace(/\[\]$/, ''), array: s.endsWith('[]') }));
  const updatePath: string[] = [];
  const arrayFilters: Document[] = [];
  let element: string | undefined; // identifier of the innermost array element so far
  let fromElement: string[] = []; // the path from that element
  segments.forEach((segment, i) => {
    updatePath.push(segment.name);
    fromElement.push(segment.name);
    if (!segment.array) return;
    if (element) arrayFilters.push({ [`${element}.${fromElement.join('.')}`]: { $type: 'array' } });
    element = `e${i}`;
    updatePath.push(`$[${element}]`);
    fromElement = [];
  });
  fromElement.push('tenantId');
  if (element) arrayFilters.push({ [`${element}.${fromElement.join('.')}`]: { $exists: true } });
  const queryPath = [...segments.map((s) => s.name), 'tenantId'].join('.');
  return {
    filter: { [queryPath]: { $exists: true } },
    update: { $unset: { [[...updatePath, 'tenantId'].join('.')]: '' } },
    ...(arrayFilters.length > 0 ? { arrayFilters } : {}),
  };
}

/** A single-key index on a nested tenantId, as the plugin made them. */
const isNestedTenantIndex = (key: Document): boolean => {
  const fields = Object.keys(key);
  return fields.length === 1 && fields[0].includes('.') && fields[0].endsWith('.tenantId');
};

export async function up(db: Db): Promise<void> {
  const collections = (
    await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray()
  )
    .map((c) => c.name)
    .filter((name) => !name.startsWith('system.'));

  let dropped = 0;
  for (const name of collections) {
    for (const index of await db.collection(name).indexes()) {
      if (!index.name || !isNestedTenantIndex(index.key)) continue;
      await db.collection(name).dropIndex(index.name);
      console.log(`${LOG} ${name}: index ${index.name} dropped`);
      dropped++;
    }
  }

  let changed = 0;
  for (const [name, specs] of Object.entries(EMBEDDED_PATHS)) {
    if (!collections.includes(name)) continue;
    for (const spec of specs) {
      const { filter, update, arrayFilters } = unsetStep(spec);
      const result = await db
        .collection(name)
        .updateMany(filter, update, arrayFilters ? { arrayFilters } : {});
      if (result.modifiedCount > 0) {
        console.log(`${LOG} ${name}.${spec}: ${result.modifiedCount} documents`);
      }
      changed += result.modifiedCount;
    }
  }

  console.log(
    `${LOG} ${dropped} nested tenantId indexes dropped; stamped tenantId removed from embedded ` +
      `documents, ${changed} documents changed (a document counts once per embedded path).`,
  );
}

/**
 * No-op. The stamped values are not put back: nothing read them, and each was its document's own
 * tenantId. The code before this release builds the dropped indexes again at start (Mongoose
 * autoIndex) and stamps new subdocuments as before.
 */
export async function down(): Promise<void> {
  // Nothing to undo: see above
}
