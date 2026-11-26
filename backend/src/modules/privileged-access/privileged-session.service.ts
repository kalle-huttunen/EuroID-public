/**
 * Privileged sessions as the API and the sweeps see them: start one and wait (bounded) for its
 * outcome, end one, and the hourly sweeps that keep every linked admin account disabled outside
 * a session. The session itself runs in privilegedSessionWorkflow (PamSessionService starts it);
 * the outcome is read from the parent's `linkedAdminAccounts` entry, which only the session
 * writes (PamSessionStateService).
 */
import { randomUUID } from 'crypto';
import {
  BadGatewayException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Identity, type IdentityDocument } from '../identity/schemas/identity.schema';
import type { LinkedAdminAccount } from '../identity/schemas/identity.schema';
import { NOT_DELETED } from '../identity/identity.constants';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { type PamConfig, pamConfig } from '@infrastructure/config/pam.config';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { PamOktaStatusReader } from '@shared/types/pam-session';
import { PamSessionService } from './pam-session.service';
import { awaitsOktaActivation, type SweepAdmin } from './pam-okta-activation';

/** How often the API reads the entry while it waits for a session's outcome. */
const WAIT_POLL_MS = 250;

/** Entry statuses of a session that has not ended. */
const OPEN_STATUSES = ['ACTIVE', 'ACTIVATING'];

/** What activation answers: enabled in time, or still enabling (202). */
export type AdminActivationResult =
  | { state: 'ACTIVE'; expiresAt: string }
  | { state: 'ACTIVATING' };

/** What deactivation answers: ended in time (INACTIVE, or PENDING if never active), or 202. */
export interface AdminDeactivationResult {
  state: 'INACTIVE' | 'PENDING' | 'DEACTIVATING';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PrivilegedSessionService {
  private readonly logger = this.loggerFactory.create(PrivilegedSessionService.name);

  constructor(
    @InjectModel(Identity.name) private readonly identityModel: Model<IdentityDocument>,
    private readonly sessions: PamSessionService,
    private readonly loggerFactory: LoggerFactoryService,
    @Inject(pamConfig.KEY) private readonly pamConf: PamConfig,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Start a session of `durationMs` and wait up to PAM_ACTIVATION_WAIT_MS for it: ACTIVE once
   * every account is enabled; a failed activation is a 502 with the reason (nothing stays
   * enabled); still enabling is ACTIVATING (the session goes on, the entry shows the outcome).
   */
  async activate(
    adminId: string,
    parentId: string,
    durationMs: number,
    tenantId: string,
  ): Promise<AdminActivationResult> {
    const sessionId = randomUUID();
    await this.sessions.startSession(adminId, tenantId, sessionId, durationMs);
    const entry = await this.waitForEntry(
      parentId,
      adminId,
      tenantId,
      (e) => e.sessionId === sessionId && (e.status === 'ACTIVE' || e.status === 'INACTIVE'),
    );
    if (entry?.sessionId !== sessionId) return { state: 'ACTIVATING' };
    if (entry.status === 'ACTIVE' && entry.expiresAt) {
      return { state: 'ACTIVE', expiresAt: new Date(entry.expiresAt).toISOString() };
    }
    if (entry.status === 'INACTIVE') {
      throw new BadGatewayException(
        `Activation of admin account ${adminId} failed: ${entry.activationError ?? 'unknown reason'}. ` +
          'Nothing stays enabled.',
      );
    }
    return { state: 'ACTIVATING' };
  }

  /**
   * End the session (or, with none running, disable the accounts in a disable-only run) and
   * wait up to PAM_ACTIVATION_WAIT_MS for the entry to leave ACTIVE and ACTIVATING.
   */
  async deactivate(
    adminId: string,
    parentId: string,
    tenantId: string,
    reason: string,
  ): Promise<AdminDeactivationResult> {
    await this.sessions.endSession(adminId, tenantId, reason);
    const entry = await this.waitForEntry(
      parentId,
      adminId,
      tenantId,
      (e) => !OPEN_STATUSES.includes(e.status),
    );
    if (!entry || OPEN_STATUSES.includes(entry.status)) return { state: 'DEACTIVATING' };
    return { state: entry.status === 'PENDING' ? 'PENDING' : 'INACTIVE' };
  }

  /**
   * The hourly sweep's safety net: every ACTIVE entry whose session has expired gets its session
   * ended (signalled, or a disable-only run started when none runs), like a deactivation.
   * Returns how many.
   */
  async endExpired(tenantId: string, now: Date): Promise<number> {
    const parents = await this.identityModel
      .find({
        tenantId,
        linkedAdminAccounts: { $elemMatch: { status: 'ACTIVE', expiresAt: { $lte: now } } },
      })
      .select('linkedAdminAccounts')
      .lean()
      .exec();
    let ended = 0;
    for (const parent of parents) {
      const expired = (parent.linkedAdminAccounts ?? []).filter(
        (la) => la.status === 'ACTIVE' && la.expiresAt && new Date(la.expiresAt) <= now,
      );
      for (const la of expired) {
        try {
          await this.sessions.endSession(la.identityId, tenantId, 'expired');
          ended++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to end the expired session of ${la.identityId}: ${msg}`);
        }
      }
    }
    return ended;
  }

  /**
   * The hourly sweep makes existing data converge: a live admin identity whose target state is
   * not known to be `disabled` (admin accounts provisioned before sessions existed, or whose
   * last disable failed), and whose entry is not ACTIVE or ACTIVATING, gets a disable-only run,
   * unless one of its runs is running. At most PAM_STANDING_STATE_SWEEP_LIMIT per tenant and
   * sweep; the rest wait for the next sweep. With `readOktaStatus`, an account whose last
   * disable failed only in Okta and that Okta still shows waiting for its owner's activation
   * gets no run (it cannot sign in; pam-okta-activation.ts) and keeps its target state, so the
   * next sweep reads it again. Returns how many runs started.
   */
  async convergeStandingState(
    tenantId: string,
    readOktaStatus?: PamOktaStatusReader,
  ): Promise<number> {
    const limit = this.pamConf.standingStateSweepLimit;
    const candidates = this.identityModel
      .find({
        tenantId,
        parentIdentityId: { $exists: true, $ne: null },
        pamTargetState: { $ne: 'disabled' },
        ...NOT_DELETED,
      })
      .select('_id parentIdentityId profile.email sources provisioning')
      .sort({ _id: 1 })
      .lean()
      .cursor();
    let started = 0;
    let waiting = 0;
    let awaitingActivation = 0;
    const now = new Date();
    const oktaDeps = {
      identityModel: this.identityModel,
      eventEmitter: this.eventEmitter,
      warn: (message: string) => this.logger.warn(`[PAM] ${message}`),
      alertAfterDays: this.pamConf.activationPendingAlertDays,
    };
    for await (const admin of candidates) {
      const adminId = String(admin._id);
      const entry = await this.entryOf(String(admin.parentIdentityId), adminId, tenantId);
      if (entry && OPEN_STATUSES.includes(entry.status)) continue;
      if (started >= limit) {
        waiting++;
        continue;
      }
      const sweepAdmin = admin as unknown as SweepAdmin;
      if (
        readOktaStatus &&
        entry &&
        (await awaitsOktaActivation(oktaDeps, sweepAdmin, entry, tenantId, readOktaStatus, now))
      ) {
        awaitingActivation++;
        continue;
      }
      if (await this.sessions.startDisable(adminId, tenantId, 'standing-state')) started++;
    }
    if (started > 0 || waiting > 0 || awaitingActivation > 0) {
      this.logger.log(
        `[PAM] Standing state: started ${started} disable runs in ${tenantId}, ` +
          `${waiting} left for the next sweep, ${awaitingActivation} waiting for Okta activation`,
      );
    }
    return started;
  }

  /**
   * After admin account provisioning: disable what it may have left enabled (an account it
   * updated with an older session state, an AD account it found existing), unless a session is
   * open or running. Returns whether a disable-only run started.
   */
  async settleAfterProvisioning(adminId: string, tenantId: string): Promise<boolean> {
    const admin = await this.identityModel
      .findOne({ _id: adminId, tenantId, ...NOT_DELETED })
      .select('parentIdentityId')
      .lean()
      .exec();
    if (!admin?.parentIdentityId) return false;
    const entry = await this.entryOf(String(admin.parentIdentityId), adminId, tenantId);
    if (entry && OPEN_STATUSES.includes(entry.status)) return false;
    try {
      return await this.sessions.startDisable(adminId, tenantId, 'provisioned');
    } catch (err: unknown) {
      // This process has no Temporal client (it could not connect at start): the provisioning
      // must not wait forever. The target state stays as it was, so the hourly sweep disables it
      if (!(err instanceof ServiceUnavailableException)) throw err;
      this.logger.warn(
        `No disable run for admin identity ${adminId} after provisioning: ${err.message}`,
      );
      return false;
    }
  }

  private async entryOf(
    parentId: string,
    adminId: string,
    tenantId: string,
  ): Promise<LinkedAdminAccount | undefined> {
    const parent = await this.identityModel
      .findOne({ _id: parentId, tenantId })
      .select('linkedAdminAccounts')
      .lean()
      .exec();
    return (parent?.linkedAdminAccounts ?? []).find((la) => la.identityId === adminId);
  }

  /** The entry once `done` holds for it, or as it is when PAM_ACTIVATION_WAIT_MS has passed. */
  private async waitForEntry(
    parentId: string,
    adminId: string,
    tenantId: string,
    done: (entry: LinkedAdminAccount) => boolean,
  ): Promise<LinkedAdminAccount | undefined> {
    const deadline = Date.now() + this.pamConf.activationWaitMs;
    for (;;) {
      const entry = await this.entryOf(parentId, adminId, tenantId);
      if ((entry && done(entry)) || Date.now() >= deadline) return entry;
      await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
}
