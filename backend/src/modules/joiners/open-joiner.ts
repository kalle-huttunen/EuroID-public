import type { Model } from 'mongoose';
import type { JoinerEventDocument } from './schemas/joiner-event.schema';

/**
 * Whether the identity is an HR joiner whose onboarding the joiner flow still owns: a joiner
 * event that is open (waiting for its start date, a full sync or Deploy, or in a mass-joiner batch
 * waiting for an admin). Onboarding started anywhere else for such an identity would skip the
 * joiner rules (start date, HR leaver, mass-joiner limit), so the identity.updated and
 * identity.sources_changed handlers start none for it. Read only: the joiners module owns the
 * collection.
 */
export async function hasOpenJoiner(
  model: Model<JoinerEventDocument>,
  tenantId: string,
  identityId: string,
): Promise<boolean> {
  return !!(await model.exists({ tenantId, identityId, open: true }).exec());
}
