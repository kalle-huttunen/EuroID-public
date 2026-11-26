/**
 * Who masters a profile field, for the Profile form (GET /identity/:id/mastery). A field an HR
 * source masters is read-only and names its owner: the API refuses to change it (409), and the
 * next HR sync would set it back. A department or job title with an active override (identity
 * controls) is read-only too and shows the override, its reason and its expiry; an operator can
 * set, change or remove that override there (AttributeOverride.tsx), as the controls route
 * allows. Other fields are kept by EuroID and stay editable.
 */
import React from 'react';
import { useIdentityMastery } from '@api/identity-api';
import { FieldOwnership } from '@shared/FieldOwnership';
import { usePermission } from '../../../auth/usePermission';
import type { IAttributeControl } from '../../../interfaces';
import { AttributeOverrideActions, type OverridableAttribute } from './AttributeOverride';

const OVERRIDABLE: readonly string[] = ['departmentName', 'jobTitle'];

/** The text under a read-only field: its owner, and the override in effect, if any. */
const MasteredHint: React.FC<{
  owner?: string;
  control?: IAttributeControl;
  actions?: React.ReactNode;
}> = ({ owner, control, actions }) => (
  <>
    <span>
      {owner ? `Mastered by ${owner}: change it in HR.` : 'Set by an override.'}
      {control && (
        <>
          {' '}
          Override in effect: {control.value}
          {control.expiresAt ? `, until ${new Date(control.expiresAt).toLocaleString()}` : ''}
          {control.reason ? ` (reason: ${control.reason})` : ''}.
        </>
      )}
    </span>
    {actions}
  </>
);

export interface FieldMastery {
  /** True when the form must not change `field`. */
  isReadOnly: (field: string) => boolean;
  /** The badge for the field's label: its HR owner, else Manual. */
  badge: (field: string) => React.ReactNode;
  /** Form.Item props of a read-only field: its owner named under it, and the override actions. */
  itemProps: (field: string) => { extra?: React.ReactNode };
}

export function useFieldMastery(identityId: string | undefined): FieldMastery {
  const { data } = useIdentityMastery(identityId);
  // The controls route needs operator
  const canOverride = usePermission('operator');
  const masteredBy = data?.masteredBy ?? {};
  const controls = data?.attributeControls ?? {};
  const controlOf = (field: string) => controls[field as OverridableAttribute];
  const isReadOnly = (field: string) => !!masteredBy[field] || !!controlOf(field);
  const actionsOf = (field: string) =>
    canOverride && identityId && OVERRIDABLE.includes(field) ? (
      <AttributeOverrideActions
        identityId={identityId}
        attribute={field as OverridableAttribute}
        owner={masteredBy[field]}
        control={controlOf(field)}
      />
    ) : null;
  return {
    isReadOnly,
    badge: (field) =>
      masteredBy[field] ? (
        <FieldOwnership owner="hr" source={masteredBy[field]} />
      ) : (
        <FieldOwnership owner="manual" />
      ),
    itemProps: (field) =>
      isReadOnly(field)
        ? {
            extra: (
              <MasteredHint
                owner={masteredBy[field]}
                control={controlOf(field)}
                actions={actionsOf(field)}
              />
            ),
          }
        : {},
  };
}
