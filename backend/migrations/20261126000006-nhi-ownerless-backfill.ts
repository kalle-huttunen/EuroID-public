/**
 * Migration: mark the NHI agents whose owner left before this release ownerless.
 *
 * From this release on, an owner's offboarding (or deletion from the hub) and an erasure mark the
 * owner's agents that are not revoked ownerless (`ownerlessSince`, `ownerlessReason`): they get no
 * new credential until a super-admin gives them a new owner or revokes them. Agents whose owner
 * left earlier carry no mark and would keep being issued credentials, so this marks them, in every
 * tenant:
 *   - the owner identity is deleted (`deletedAt`): `offboarded`;
 *   - the owner identity no longer exists in the agent's tenant: `erased` when the erasure took
 *     the owner email out (`(erased)`), else `offboarded` (deleted another way).
 * A revoked agent, and one already marked, is left as it is. An owner who is only suspended is not
 * taken as gone (a suspension can be temporary). Rerunning it changes nothing.
 */
import { Db, ObjectId } from 'mongodb';

const AGENTS = 'agent_identities';
const IDENTITIES = 'identities';
/** gdpr-erasure-scope.ts ERASED_OWNER_EMAIL. */
const ERASED_OWNER_EMAIL = '(erased)';

interface AgentRow {
  _id: ObjectId;
  tenantId: string;
  owner?: { identityId?: string; email?: string };
}

export async function up(db: Db): Promise<void> {
  const agents = db.collection<AgentRow>(AGENTS);
  const identities = db.collection(IDENTITIES);
  const cursor = agents.find(
    { status: { $ne: 'revoked' }, ownerlessSince: { $exists: false } },
    { projection: { tenantId: 1, owner: 1 } },
  );
  const now = new Date();
  let marked = 0;
  for await (const agent of cursor) {
    const ownerId = agent.owner?.identityId;
    if (!ownerId) continue;
    const owner = ObjectId.isValid(ownerId)
      ? await identities.findOne(
          { _id: new ObjectId(ownerId), tenantId: agent.tenantId },
          { projection: { deletedAt: 1 } },
        )
      : null;
    if (owner && !owner.deletedAt) continue;
    const reason = !owner && agent.owner?.email === ERASED_OWNER_EMAIL ? 'erased' : 'offboarded';
    const result = await agents.updateOne(
      { _id: agent._id, ownerlessSince: { $exists: false } },
      { $set: { ownerlessSince: now, ownerlessReason: reason } },
    );
    marked += result.modifiedCount;
  }
  console.log(`[migration] agent_identities: ${marked} agents of owners who left marked ownerless`);
}

/**
 * Leaves the marks: removing them would let agents whose owner left be issued credentials again,
 * and the marks the API set after `up` cannot be told from the ones `up` set.
 */
export async function down(): Promise<void> {}
