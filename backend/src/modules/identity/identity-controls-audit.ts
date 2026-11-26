/**
 * The audit entries of identity controls (IdentityControlsService): each attribute control set,
 * removed or expired, the kill switch turned on or off, and the email override set or removed.
 * Values of an attribute control are logged; an email only masked. No names.
 */
import type { LogAuditEvent } from '../audit/audit.service';
import type { IdentityDocument } from './schemas/identity.schema';
import { ATTRIBUTE_CONTROLS, type AttributeControlChange } from './attribute-controls';
import { maskEmail } from './identity-pii';

/** Audit action per control change. */
const AUDIT_ACTIONS: Record<AttributeControlChange['action'], string> = {
  set: 'IDENTITY_CONTROL_SET',
  removed: 'IDENTITY_CONTROL_REMOVED',
  expired: 'IDENTITY_CONTROL_EXPIRED',
};

function entryOf(identity: IdentityDocument, actor: string | undefined) {
  const identityId = String(identity._id);
  return {
    actor: actor || 'unknown',
    resourceType: 'identity',
    resourceId: identityId,
    resourceName: `Identity ${identityId}`,
    tenantId: identity.tenantId,
  };
}

/** One attribute control change: values, reason and expiry. */
export function attributeControlAuditEntry(
  identity: IdentityDocument,
  change: AttributeControlChange,
  actor: string | undefined,
): LogAuditEvent {
  const field = ATTRIBUTE_CONTROLS[change.attribute];
  const reason = change.info?.reason;
  const expiresAt = change.info?.expiresAt?.toISOString();
  const what = {
    set: `set to "${change.value}"`,
    removed: 'removed',
    expired: 'ended at its expiry',
  }[change.action];
  return {
    ...entryOf(identity, actor),
    action: AUDIT_ACTIONS[change.action],
    severity: change.action === 'set' ? 'warning' : 'info',
    description:
      `Control ${field} ${what}` +
      (reason ? `. Reason: ${reason}` : '') +
      (expiresAt ? `. Until ${expiresAt}` : ''),
    payload: {
      before: { [field]: change.previous ?? null },
      after: { [field]: change.action === 'set' ? change.value : null },
      metadata: {
        attribute: change.attribute,
        ...(reason ? { reason } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
    },
  };
}

/** The kill switch (controls.isLoginDisabled) turned on or off. */
export function loginSwitchAuditEntry(
  identity: IdentityDocument,
  disabled: boolean,
  actor: string | undefined,
): LogAuditEvent {
  return {
    ...entryOf(identity, actor),
    action: disabled ? 'IDENTITY_LOGIN_DISABLED' : 'IDENTITY_LOGIN_ENABLED',
    severity: disabled ? 'warning' : 'info',
    description: disabled
      ? 'Login disabled (kill switch): status SUSPENDED'
      : 'Login enabled again (kill switch off): the status before it returns',
    payload: { before: { isLoginDisabled: !disabled }, after: { isLoginDisabled: disabled } },
  };
}

/** The email override set, changed or removed, the addresses masked. */
export function emailOverrideAuditEntry(
  identity: IdentityDocument,
  before: string | undefined,
  after: string | undefined,
  actor: string | undefined,
): LogAuditEvent {
  const masked = (email: string | undefined) => (email ? maskEmail(email) : null);
  return {
    ...entryOf(identity, actor),
    action: after ? 'IDENTITY_EMAIL_OVERRIDE_SET' : 'IDENTITY_EMAIL_OVERRIDE_REMOVED',
    severity: after ? 'warning' : 'info',
    description: after
      ? `Email override set to ${masked(after)}`
      : 'Email override removed: the email the sources give returns',
    payload: { before: { emailOverride: masked(before) }, after: { emailOverride: masked(after) } },
  };
}
