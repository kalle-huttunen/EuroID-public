/**
 * Attribute controls: the one override of an HR-mastered trigger attribute (owner decision of
 * 2026-11-24). PATCH /identity/:id refuses a manual edit of a field an HR source masters (409);
 * the override is the explicit control of PATCH /identity/v2/:id/controls (`manualDepartment`,
 * `manualJobTitle`), with a required reason and an optional expiry, audited.
 *
 * While a control is set, reconcile writes its value into the profile and the policy contracts
 * take it (controlledContractValue in manual-contract-overrides.ts), so the profile and the
 * contracts agree whatever HR sends meanwhile. It ends when removed, or when the hourly expiry
 * sweep passes its `expiresAt` (IdentityControlsService.endExpiredControls); then the HR value
 * returns and the mover runs.
 *
 * Pure and dependency-free.
 */

import type { ContractAttribute } from './manual-contract-overrides';

/** The control field that overrides each attribute. */
export const ATTRIBUTE_CONTROLS = {
  departmentName: 'manualDepartment',
  jobTitle: 'manualJobTitle',
} as const satisfies Record<ContractAttribute, string>;

export type AttributeControlField = (typeof ATTRIBUTE_CONTROLS)[ContractAttribute];

export const CONTROLLED_ATTRIBUTES = Object.keys(ATTRIBUTE_CONTROLS) as ContractAttribute[];

/** Why, by whom, since and until when a control is set (`controls.<field>Info`). */
export interface AttributeControlInfo {
  reason?: string;
  setBy?: string;
  setAt?: Date;
  expiresAt?: Date;
}

/** The attribute controls as IdentityControls stores them. */
export interface StoredAttributeControls {
  manualDepartment?: string | null;
  manualDepartmentInfo?: AttributeControlInfo | null;
  manualJobTitle?: string | null;
  manualJobTitleInfo?: AttributeControlInfo | null;
}

/** The attribute control part of a controls update (UpdateIdentityControlsSchema). */
export interface AttributeControlsUpdate {
  manualDepartment?: string | null;
  manualJobTitle?: string | null;
  reason?: string;
  /** ISO date-time. */
  expiresAt?: string;
}

/** What a change did to one control: set (a new value, reason or expiry), removed, expired. */
export interface AttributeControlChange {
  attribute: ContractAttribute;
  action: 'set' | 'removed' | 'expired';
  /** The value set (action set). */
  value?: string;
  /** The value the control had before, if any. */
  previous?: string;
  /** The reason and expiry set (action set); the reason of a removal, if given. */
  info?: AttributeControlInfo;
}

/** The field next to each control that holds its reason and expiry. */
const INFO_FIELDS = {
  departmentName: 'manualDepartmentInfo',
  jobTitle: 'manualJobTitleInfo',
} as const satisfies Record<ContractAttribute, keyof StoredAttributeControls>;

const infoOf = (
  controls: StoredAttributeControls | null | undefined,
  attribute: ContractAttribute,
): AttributeControlInfo | undefined => controls?.[INFO_FIELDS[attribute]] ?? undefined;

/** The value of the control of `attribute`, undefined when none is set. */
export function controlValue(
  controls: StoredAttributeControls | null | undefined,
  attribute: ContractAttribute,
): string | undefined {
  const value = controls?.[ATTRIBUTE_CONTROLS[attribute]];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** True when the request names an attribute control with a value, which needs a reason. */
export function setsAttributeControl(update: AttributeControlsUpdate): boolean {
  return CONTROLLED_ATTRIBUTES.some((attribute) => {
    const value = update[ATTRIBUTE_CONTROLS[attribute]];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/**
 * The changes `update` makes to the attribute controls in `current`. A field the request leaves
 * out is left as it is; a value sets the control (with the request's reason and expiry, `actor`
 * and `now` as who and when); `''` or null removes it, with the request's reason if it gives one.
 * Removing a control that is not set is no change.
 */
export function attributeControlChanges(
  current: StoredAttributeControls | null | undefined,
  update: AttributeControlsUpdate,
  actor: string | undefined,
  now: Date,
): AttributeControlChange[] {
  const changes: AttributeControlChange[] = [];
  for (const attribute of CONTROLLED_ATTRIBUTES) {
    const field = ATTRIBUTE_CONTROLS[attribute];
    if (!(field in update)) continue;
    const requested = update[field];
    const value = typeof requested === 'string' ? requested.trim() : '';
    const previous = controlValue(current, attribute);
    if (value === '') {
      // A removal's reason is optional; given, the audit records it
      const why = update.reason?.trim();
      if (previous !== undefined) {
        changes.push({
          attribute,
          action: 'removed',
          previous,
          ...(why ? { info: { reason: why, setAt: now, ...(actor ? { setBy: actor } : {}) } } : {}),
        });
      }
      continue;
    }
    const info: AttributeControlInfo = {
      reason: update.reason?.trim(),
      setAt: now,
      ...(actor ? { setBy: actor } : {}),
      ...(update.expiresAt ? { expiresAt: new Date(update.expiresAt) } : {}),
    };
    changes.push({ attribute, action: 'set', value, previous, info });
  }
  return changes;
}

/** The controls of `current` whose expiry is at or before `now`, as changes that end them. */
export function expiredControlChanges(
  current: StoredAttributeControls | null | undefined,
  now: Date,
): AttributeControlChange[] {
  const changes: AttributeControlChange[] = [];
  for (const attribute of CONTROLLED_ATTRIBUTES) {
    const previous = controlValue(current, attribute);
    const expiresAt = infoOf(current, attribute)?.expiresAt;
    if (previous === undefined || !expiresAt) continue;
    if (new Date(expiresAt).getTime() <= now.getTime()) {
      changes.push({ attribute, action: 'expired', previous });
    }
  }
  return changes;
}

/**
 * The paths under `controls` a change writes and their values: the value and its info for a set,
 * undefined (unset) for both when the control ends.
 */
export function controlPaths(change: AttributeControlChange): Record<string, unknown> {
  const set = change.action === 'set';
  return {
    [ATTRIBUTE_CONTROLS[change.attribute]]: set ? change.value : undefined,
    [INFO_FIELDS[change.attribute]]: set ? change.info : undefined,
  };
}

/** The query paths of the controls' expiry, for the sweep's filter. */
export const CONTROL_EXPIRY_PATHS = CONTROLLED_ATTRIBUTES.map(
  (attribute) => `controls.${INFO_FIELDS[attribute]}.expiresAt`,
);

/** The active controls, attribute -> value, reason, who set it, when, and until when. */
export function activeAttributeControls(
  controls: StoredAttributeControls | null | undefined,
): Partial<Record<ContractAttribute, AttributeControlInfo & { value: string }>> {
  const active: Partial<Record<ContractAttribute, AttributeControlInfo & { value: string }>> = {};
  for (const attribute of CONTROLLED_ATTRIBUTES) {
    const value = controlValue(controls, attribute);
    if (value !== undefined) active[attribute] = { value, ...infoOf(controls, attribute) };
  }
  return active;
}
