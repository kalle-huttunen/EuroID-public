/**
 * A person's live linked admin identities (PAM): the identities whose `parentIdentityId` is the
 * person and those the person's `linkedAdminAccounts` entries name, not soft-deleted, in this
 * tenant, oldest first, each with its email (its UPN). Offboarding the person offboards them
 * first (PrivilegedAccessService.findLiveLinkedAdmins, the getLinkedAdminIdentities activity), and
 * a person is never deleted while one is live: the offboarding workflow reads them again right
 * before the delete, and closing the last failed target of the person's offboarding by hand
 * (LeaverManualRemovalService) refuses while one is live.
 */
import { isValidObjectId, type Model } from 'mongoose';
import type { IdentityDocument } from './schemas/identity.schema';
import { NOT_DELETED } from './identity.constants';

export interface LiveLinkedAdmin {
  identityId: string;
  email: string;
}

export async function findLiveLinkedAdmins(
  identityModel: Model<IdentityDocument>,
  parentIdentityId: string,
  tenantId: string,
): Promise<LiveLinkedAdmin[]> {
  const parent = await identityModel
    .findOne({ _id: parentIdentityId, tenantId })
    .select('linkedAdminAccounts')
    .lean()
    .exec();
  const entryIds = (parent?.linkedAdminAccounts ?? [])
    .map((la) => la.identityId)
    .filter((id) => isValidObjectId(id) && id !== parentIdentityId);
  const admins = await identityModel
    .find({
      tenantId,
      ...NOT_DELETED,
      $or: [{ parentIdentityId }, { _id: { $in: entryIds } }],
    })
    .select('_id profile.email')
    .sort({ _id: 1 })
    .lean()
    .exec();
  return admins
    .filter((admin) => String(admin._id) !== parentIdentityId)
    .map((admin) => ({ identityId: String(admin._id), email: admin.profile?.email ?? '' }));
}
