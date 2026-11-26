import { Logger } from '@nestjs/common';

/** Statuses of a request whose access the identity holds, or is being given right now. */
export const HELD_REQUEST_STATUSES = ['ACTIVE', 'PROVISIONING'];

/**
 * How long a request may stay PROVISIONING and still count as access being given. The approval
 * workflow marks a request PROVISIONING just before provisionAccessRequest (one attempt runs at
 * most 2 minutes, its startToCloseTimeout) and ACTIVE or REJECTED right after it. A request still
 * PROVISIONING a day later has lost its run (terminated, or a worker that could not run the
 * activity), and nothing moves it on: counting it would keep a ghost entitlement in the SoD
 * check, in the revoke of another request for the same entitlement and in the mover's grants.
 */
export const PROVISIONING_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const logger = new Logger('HeldAccessRequests');

/** A request as the held-access readers load it. */
export interface HeldRequestCandidate {
  requestId?: string;
  status?: string;
  updatedAt?: Date | string;
}

/**
 * The requests that count as held access: ACTIVE ones, and PROVISIONING ones marked so (their
 * last update, the claim) within PROVISIONING_STALE_AFTER_MS. A stale PROVISIONING request is
 * left out and logged, so an operator can find and close it. One without a readable update time
 * counts, as before.
 */
export function heldRequests<T extends HeldRequestCandidate>(
  requests: T[],
  now: Date = new Date(),
): T[] {
  return requests.filter((request) => {
    if (request.status !== 'PROVISIONING') return true;
    const since = request.updatedAt ? new Date(request.updatedAt).getTime() : NaN;
    // No readable time: counted, as before
    if (Number.isNaN(since) || now.getTime() - since <= PROVISIONING_STALE_AFTER_MS) return true;
    logger.warn(
      `[AccessRequest] ${request.requestId ?? '(unknown)'} has been PROVISIONING since ` +
        `${new Date(since).toISOString()}: stale, not counted as held access`,
    );
    return false;
  });
}
