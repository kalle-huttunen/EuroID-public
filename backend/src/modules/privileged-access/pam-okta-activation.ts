/**
 * The hourly standing-state sweep and Okta admin accounts waiting for their owner's activation.
 *
 * A privileged session's first enable activates a STAGED Okta account, which leaves it
 * PROVISIONED until its owner finishes the activation Okta emailed. Okta suspends only an ACTIVE
 * user, so the session's disable fails there (422) and the entry keeps `pamTargetState: enabled`
 * with the failure in `disableError`. A PROVISIONED (or STAGED) account cannot sign in, so nothing
 * needs containing yet: the sweep reads its Okta status first and starts no disable-only run
 * while it waits, instead of one failing run per hour. Once it has waited
 * PAM_ACTIVATION_PENDING_ALERT_DAYS, one `admin_account.activation_pending` event (audited,
 * webhook-subscribable) asks a person to finish or remove it; the entry's
 * `activationPendingAlertedAt` keeps it to one until a disable succeeds. The mark is claimed
 * before the event and taken back when the event cannot be emitted, so the next sweep raises it.
 */
import type { Model } from 'mongoose';
import type { IdentityDocument, LinkedAdminAccount } from '../identity/schemas/identity.schema';
import type { LinkedAccount, ProvisioningState } from '../identity/schemas/identity.schema';
import { provisionedSystems, targetAccountId } from '../identity/identity-provisioning.service';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { normalizeSystemName } from '@shared/utils/normalize-system-name';
import type { PamOktaStatusReader } from '@shared/types/pam-session';

/** Okta statuses of an account that waits for its owner: it cannot sign in, nor be suspended. */
export const OKTA_AWAITING_ACTIVATION: readonly string[] = ['PROVISIONED', 'STAGED'];

const OKTA = 'okta';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether every failure the last disable recorded is an Okta one. The session records them as
 * `<system>: <reason>` joined by `; ` (privilegedSessionWorkflow, asDeprovisionFailure). A
 * failure in another system still needs the disable-only run.
 */
export function onlyOktaDisableFailures(disableError: string | undefined): boolean {
  if (!disableError) return false;
  return disableError.split('; ').every((part) => part.trim().toLowerCase().startsWith(`${OKTA}:`));
}

export interface SweepAdmin {
  _id: unknown;
  parentIdentityId?: string | null;
  profile?: { email?: string } | null;
  sources?: Array<Pick<LinkedAccount, 'sourceName' | 'externalId' | 'sourceRole'>>;
  provisioning?: Array<
    Pick<ProvisioningState, 'targetSystem' | 'status' | 'provisionedAt' | 'writebackComplete'>
  > | null;
}

export interface OktaActivationDeps {
  identityModel: Model<IdentityDocument>;
  eventEmitter: DomainEventEmitterService;
  warn: (message: string) => void;
  alertAfterDays: number;
}

/**
 * Whether the sweep should start no disable-only run for this admin account now: its last disable
 * failed only in Okta and Okta still says it waits for activation. Raises the one alert once it
 * has waited `alertAfterDays` (since Okta's `statusChanged`, else since the session ended). A
 * failed read, an account Okta does not know, or any other status answer false: the run starts
 * as before.
 */
export async function awaitsOktaActivation(
  deps: OktaActivationDeps,
  admin: SweepAdmin,
  entry: LinkedAdminAccount,
  tenantId: string,
  readOktaStatus: PamOktaStatusReader,
  now: Date,
): Promise<boolean> {
  if (!onlyOktaDisableFailures(entry.disableError)) return false;
  const oktaSystem = provisionedSystems(admin).find((s) => normalizeSystemName(s) === OKTA);
  const login = admin.profile?.email;
  if (!oktaSystem || !login) return false;
  const adminId = String(admin._id);
  let read: Awaited<ReturnType<PamOktaStatusReader>>;
  try {
    read = await readOktaStatus({ oktaUserId: targetAccountId(admin.sources, oktaSystem), login });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.warn(`Could not read the Okta status of admin identity ${adminId}: ${msg}`);
    return false;
  }
  if (!read || !OKTA_AWAITING_ACTIVATION.includes(read.status)) return false;

  const since = read.statusChanged ? new Date(read.statusChanged) : entry.deactivatedAt;
  const waitedLongEnough =
    since && !Number.isNaN(new Date(since).getTime())
      ? now.getTime() - new Date(since).getTime() >= deps.alertAfterDays * DAY_MS
      : false;
  if (waitedLongEnough && admin.parentIdentityId) {
    const claimed = await deps.identityModel
      .updateOne(
        {
          _id: admin.parentIdentityId,
          tenantId,
          linkedAdminAccounts: {
            $elemMatch: { identityId: adminId, activationPendingAlertedAt: { $exists: false } },
          },
        },
        { $set: { 'linkedAdminAccounts.$.activationPendingAlertedAt': now } },
      )
      .exec();
    if (claimed.modifiedCount > 0) {
      try {
        deps.eventEmitter.emit(DomainEventType.ADMIN_ACCOUNT_ACTIVATION_PENDING, adminId, {
          parentIdentityId: admin.parentIdentityId,
          targetSystem: OKTA,
          targetStatus: read.status,
          pendingSince: new Date(since as Date).toISOString(),
          alertAfterDays: deps.alertAfterDays,
        });
      } catch (err: unknown) {
        // The mark stands for an alert raised: without the event, the next sweep raises it
        await deps.identityModel
          .updateOne(
            {
              _id: admin.parentIdentityId,
              tenantId,
              linkedAdminAccounts: {
                $elemMatch: { identityId: adminId, activationPendingAlertedAt: now },
              },
            },
            { $unset: { 'linkedAdminAccounts.$.activationPendingAlertedAt': '' } },
          )
          .exec();
        const msg = err instanceof Error ? err.message : String(err);
        deps.warn(`Activation-pending alert for admin identity ${adminId} not raised: ${msg}`);
      }
    }
  }
  return true;
}
