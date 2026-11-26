import type { Model } from 'mongoose';
import { toOperationType } from '@shared/utils/entitlement-operation-type';
import type { RequestGrant } from '@shared/utils/entitlement-delta';
import type { AccessRequestDocument } from './schemas/access-request.schema';
import { HELD_REQUEST_STATUSES, heldRequests } from './held-requests';

/**
 * The entitlements the identity's active access requests grant (ACTIVE, or PROVISIONING and not
 * stale: heldRequests), the identity as target, or as requester of a request without one: findActiveRequestsForIdentity's
 * rule), each with its native id, the one provisioning used. Entitlements without a native id are
 * never provisioned and are left out. Read only, for the mover and its access preview, which must
 * not remove what a request granted (withoutRequestGrants).
 */
export async function activeRequestGrants(
  model: Model<AccessRequestDocument>,
  tenantId: string,
  identityId: string,
): Promise<RequestGrant[]> {
  const requests = (await model
    .find(
      {
        tenantId,
        $or: [
          { targetIdentityId: identityId },
          { targetIdentityId: null, requesterId: identityId },
        ],
        status: { $in: HELD_REQUEST_STATUSES },
      },
      { entitlements: 1, requestId: 1, status: 1, updatedAt: 1 },
    )
    .lean()
    .exec()) as Array<{
    requestId?: string;
    status?: string;
    updatedAt?: Date;
    entitlements?: Array<{ system: string; entitlementType?: string; nativeId?: string }>;
  }>;
  return heldRequests(requests).flatMap((request) =>
    (request.entitlements ?? [])
      .filter((e): e is typeof e & { nativeId: string } => !!e.nativeId)
      .map((e) => ({
        system: e.system,
        type: toOperationType(e.entitlementType),
        nativeId: e.nativeId,
      })),
  );
}
