/**
 * Payload schemas of the console admin events (`modules/auth`, collection `admin_users`), merged
 * into EVENT_SCHEMAS (event-payload-schemas.ts). Ids and roles only: no email, and never an invite
 * code, a reset token or a password. Interfaces: event-payloads.ts.
 */
import { z } from 'zod';
import { DomainEventType } from './event-types';

/**
 * invite.created (InviteService.createInvite): the invite's id is the aggregate, the tenant the
 * event's own. No email: the pending invite list (GET /auth/invites) shows it to a super-admin.
 */
const inviteCreatedSchema = z.object({
  roles: z.array(z.string()),
  createdBy: z.string(),
  expiresAt: z.string(),
});

/** InviteCancelledPayload */
const inviteCancelledSchema = z.object({
  roles: z.array(z.string()),
  createdBy: z.string(),
  cancelledBy: z.string(),
  expiresAt: z.string(),
});

/** AdminUserRoleChangedPayload */
const adminUserRoleChangedSchema = z.object({
  adminUserId: z.string(),
  previousRole: z.string(),
  newRole: z.string(),
  changedBy: z.string(),
});

/** AdminUserPasswordResetRequestedPayload */
const passwordResetRequestedSchema = z.object({
  adminUserId: z.string(),
  mailSent: z.boolean(),
});

/** AdminUserPasswordResetIssuedPayload */
const passwordResetIssuedSchema = z.object({
  adminUserId: z.string(),
  issuedBy: z.string(),
  expiresAt: z.string(),
});

/** AdminUserPasswordResetCompletedPayload */
const passwordResetCompletedSchema = z.object({ adminUserId: z.string() });

export const ADMIN_USER_EVENT_SCHEMAS: Partial<Record<DomainEventType, z.ZodSchema>> = {
  [DomainEventType.INVITE_CREATED]: inviteCreatedSchema,
  [DomainEventType.INVITE_CANCELLED]: inviteCancelledSchema,
  [DomainEventType.ADMIN_USER_ROLE_CHANGED]: adminUserRoleChangedSchema,
  [DomainEventType.ADMIN_USER_PASSWORD_RESET_REQUESTED]: passwordResetRequestedSchema,
  [DomainEventType.ADMIN_USER_PASSWORD_RESET_ISSUED]: passwordResetIssuedSchema,
  [DomainEventType.ADMIN_USER_PASSWORD_RESET_COMPLETED]: passwordResetCompletedSchema,
};
