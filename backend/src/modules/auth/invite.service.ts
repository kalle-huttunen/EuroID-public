import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes, createHash } from 'crypto';
import { Invite, InviteDocument } from './schemas/invite.schema';
import { AdminUser, AdminUserDocument } from './schemas/admin-user.schema';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { InviteCancelledPayload } from '@infrastructure/events/event-payloads';

const INVITE_EXPIRY_HOURS = 72;
const VALID_ROLES = ['super-admin', 'connector-admin', 'policy-admin', 'operator', 'viewer'];

const INVALID_INVITE = 'Invite token invalid, already used, or expired';

function hashToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

/** Filter for an invite that can still be used. */
function usable() {
  return { usedAt: { $exists: false }, expiresAt: { $gt: new Date() } };
}

/** What an invite grants the admin who registers with it. */
export interface InviteGrant {
  email: string;
  roles: string[];
  tenantId: string;
}

/** One pending invite in GET /auth/invites: never the code or its hash. */
export interface PendingInvite {
  id: string;
  email: string;
  /** The role the invitee gets (the first of the invite's roles). */
  role: string;
  /** The inviter's id as their token named it (an admin id, an OIDC subject, emergency-admin). */
  createdBy: string;
  createdAt?: Date;
  expiresAt: Date;
}

/** The only invite fields the list reads (never tokenHash or a legacy token). */
const PENDING_INVITE_FIELDS = 'email roles createdBy createdAt expiresAt';

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);

  constructor(
    @InjectModel(Invite.name) private inviteModel: Model<InviteDocument>,
    private eventEmitter: DomainEventEmitterService,
    @InjectModel(AdminUser.name) private adminModel: Model<AdminUserDocument>,
  ) {}

  /**
   * An address with an account in the inviter's tenant is refused (409): registering it would
   * fail. One with an account in another tenant is not: telling the inviter would reveal who has
   * an account elsewhere. Registration tells the invitee instead, and the invite stays pending
   * until it expires (GET /auth/invites).
   */
  async createInvite(
    email: string,
    roles: string[],
    createdBy: string,
    tenantId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const validRoles = roles.filter((r) => VALID_ROLES.includes(r));
    if (validRoles.length === 0) {
      throw new BadRequestException('At least one valid role is required');
    }
    const normalized = email.toLowerCase().trim();
    if (await this.adminModel.exists({ email: normalized, tenantId })) {
      throw new ConflictException(
        'This email address already has an admin account in this tenant. No invite is needed.',
      );
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

    const invite = await this.inviteModel.create({
      email: normalized,
      tokenHash,
      roles: validRoles,
      createdBy,
      expiresAt,
      tenantId,
    });

    // Never the token: every event reaches the audit log, webhooks and Socket.IO, and the token
    // alone lets its holder register with the invited role. Only the inviter receives it. No
    // email either: the pending invite list shows it to a super-admin. The tenant is the event's,
    // as for invite.cancelled.
    this.eventEmitter.emit(
      DomainEventType.INVITE_CREATED,
      invite._id.toString(),
      { roles: validRoles, createdBy, expiresAt: expiresAt.toISOString() },
      { tenantId },
    );

    this.logger.log(`Invite created (roles: ${validRoles.join(', ')})`);
    return { token, expiresAt };
  }

  /** The tenant's invites that can still be used, newest first. */
  async listPending(tenantId: string): Promise<PendingInvite[]> {
    const invites = await this.inviteModel
      .find({ tenantId, ...usable() }, PENDING_INVITE_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .lean<Array<Partial<Invite> & { _id: unknown; createdAt?: Date }>>();
    return invites.map((invite) => ({
      id: String(invite._id),
      email: invite.email ?? '',
      role: invite.roles?.[0] ?? 'viewer',
      createdBy: String(invite.createdBy ?? ''),
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt as Date,
    }));
  }

  /**
   * Cancel a pending invite of `tenantId`: it is deleted, so its code no longer registers anyone.
   * False when the tenant has no usable invite with this id (another tenant's, used, expired).
   */
  async cancel(id: string, tenantId: string, cancelledBy: string): Promise<boolean> {
    const invite = await this.inviteModel.findOneAndDelete({ _id: id, tenantId, ...usable() });
    if (!invite) return false;
    const payload: InviteCancelledPayload = {
      roles: invite.roles,
      createdBy: String(invite.createdBy),
      cancelledBy,
      expiresAt: invite.expiresAt.toISOString(),
    };
    this.eventEmitter.emit(DomainEventType.INVITE_CANCELLED, id, payload, { tenantId });
    this.logger.log(`Invite ${id} cancelled`);
    return true;
  }

  /**
   * Register against an invite: `register` runs only for a usable invite issued to `email`, and
   * the invite is used up together with it. A wrong email, an unknown, used or expired token, or a
   * failed `register` leaves the invite as it was, so the invitee can try again.
   *
   * Called by the public POST /auth/register, which has no tenant context: the token identifies
   * the invite across tenants (as a SCIM token does), so the lookups skip the tenant scope, and
   * the invite's stored tenant is the one the new admin joins.
   *
   * The claim is one conditional update, so of two registrations racing for one invite only one
   * runs `register`. Deployments run MongoDB without a replica set (docker-compose), so there is
   * no transaction: a failed `register` releases the claim instead.
   */
  async redeemInvite<T>(
    token: string,
    email: string,
    register: (grant: InviteGrant) => Promise<T>,
  ): Promise<T> {
    const invite = await this.findUsableInvite(token);
    if (email.toLowerCase().trim() !== invite.email) {
      throw new BadRequestException('Email does not match the invite');
    }

    const usedAt = new Date();
    const claimed = await this.inviteModel.findOneAndUpdate(
      { _id: invite._id, ...usable() },
      // A legacy plaintext-token invite moves to tokenHash as it is used.
      { $set: { usedAt, tokenHash: hashToken(token) }, $unset: { token: 1 } },
      { new: true, skipTenantScope: true },
    );
    if (!claimed) throw new UnauthorizedException(INVALID_INVITE);

    try {
      return await register({
        email: claimed.email,
        roles: claimed.roles,
        tenantId: claimed.tenantId,
      });
    } catch (err: unknown) {
      await this.inviteModel
        .updateOne({ _id: invite._id, usedAt }, { $unset: { usedAt: 1 } })
        .setOptions({ skipTenantScope: true })
        .catch((releaseErr: unknown) =>
          this.logger.error(
            `Could not release invite ${String(invite._id)} after a failed registration: ${
              releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
            }`,
          ),
        );
      throw err;
    }
  }

  /** The unused, unexpired invite for a token (tokenHash, or a legacy plaintext token), or 401. */
  private async findUsableInvite(token: string): Promise<InviteDocument> {
    const invite =
      (await this.inviteModel.findOne({ tokenHash: hashToken(token), ...usable() }, null, {
        skipTenantScope: true,
      })) ??
      (await this.inviteModel.findOne({ token: token.trim(), ...usable() }, null, {
        skipTenantScope: true,
      }));
    if (!invite) throw new UnauthorizedException(INVALID_INVITE);
    return invite;
  }
}
