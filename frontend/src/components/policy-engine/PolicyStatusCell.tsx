/**
 * The status control of one policy row. An active or disabled policy has the on/off toggle
 * (PATCH /policy/:id/toggle). A draft goes live only through Activate (POST /policy/:id/activate):
 * the API refuses to toggle a draft (400), so its toggle is disabled and points at Activate.
 *
 * Activate is disabled, with the reason, for the admin the API would refuse (403, segregation of
 * duties): the last editor of the conditions, actions or role bundle, or for a policy never so
 * edited its creator. The page knows the admin by the email of the session; when the session names
 * none, Activate stays on and the API's refusal shows in the toast.
 */
import React from 'react';
import { Button, Space, Switch, Tooltip } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import type { Policy } from './types';

/** Why the API would refuse this admin's activation of the policy, or null if it would not. */
function ownActivationRefusal(policy: Policy, myEmail?: string): string | null {
  // As PolicyService.activate: the last editor of the grants, else the creator; 'system' (seeded
  // policies) is exempt.
  const author = policy.lastEditedBy || policy.createdBy;
  if (!myEmail || !author || author === 'system' || author !== myEmail) return null;
  return policy.lastEditedBy
    ? 'Another policy admin must activate a rule whose conditions, actions or role bundle you last changed.'
    : 'Another policy admin must activate a rule you created.';
}

interface Props {
  policy: Policy;
  /** The admin may change policies (policy-admin). */
  canEdit: boolean;
  /** Email of the signed-in admin, as the API records it in createdBy and lastEditedBy. */
  myEmail?: string;
  activating: boolean;
  onToggle: (policy: Policy) => void;
  onActivate: (policy: Policy) => void;
}

export const PolicyStatusCell: React.FC<Props> = ({
  policy,
  canEdit,
  myEmail,
  activating,
  onToggle,
  onActivate,
}) => {
  if (!canEdit) {
    return <span style={{ fontSize: 12 }}>{policy.status === 'active' ? 'On' : 'Off'}</span>;
  }

  const isDraft = policy.status === 'draft';
  const toggle = (
    <Switch
      checked={policy.status === 'active'}
      disabled={isDraft}
      onChange={() => onToggle(policy)}
      checkedChildren="On"
      unCheckedChildren="Off"
      size="small"
      onClick={(_, e) => e.stopPropagation()}
    />
  );
  if (!isDraft) return toggle;

  const refusal = ownActivationRefusal(policy, myEmail);
  // A click on the disabled toggle or button must not open the editor (the row's click).
  return (
    <Space size={[6, 4]} wrap onClick={(e) => e.stopPropagation()}>
      <Tooltip title="A draft goes live through Activate. The switch then turns the rule off and on.">
        {toggle}
      </Tooltip>
      <Tooltip title={refusal ?? 'Put this rule live. A policy admin other than its author.'}>
        <Button
          size="small"
          type="primary"
          ghost
          icon={<CheckCircleOutlined />}
          aria-label={`Activate ${policy.name}`}
          disabled={!!refusal}
          loading={activating}
          onClick={() => onActivate(policy)}
        >
          Activate
        </Button>
      </Tooltip>
    </Space>
  );
};
