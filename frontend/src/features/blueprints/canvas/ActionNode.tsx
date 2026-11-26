/**
 * ActionNode — Visual policy action (target system, action type).
 * Red border when validation errors exist. Target handle on left.
 * Names come from the connector registry: the target connector's name and its policy action's
 * label (e.g. Active Directory / Assign AD Group); actions on All Systems use the labels below.
 */
import React, { memo } from 'react';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { Tooltip, theme } from 'antd';
import { ThunderboltOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { usePolicyDraftStore } from '@stores/policy-draft-store';
import { getPolicyActionLabel, getPolicyTargetLabel } from '../shared';

interface ActionNodeData {
  [key: string]: unknown;
  targetSystem?: string;
  actionType?: string;
}

const actionLabels: Record<string, string> = {
  assign_group: 'Assign Group',
  create_account: 'Create Account',
  remove_access: 'Remove Access',
  send_notification: 'Send Notification',
};

const ActionNodeComponent: React.FC<NodeProps<Node<ActionNodeData, 'action'>>> = ({ id, data }) => {
  const { token } = theme.useToken();
  const validationErrors = usePolicyDraftStore((s) => s.validationErrors);
  const nodeErrors = validationErrors.filter((e) => e.nodeId === id);
  const hasErrors = nodeErrors.length > 0;

  const d = data as ActionNodeData;
  const target = d.targetSystem || '...';
  const action = d.actionType || '...';
  const targetLabel = d.targetSystem ? getPolicyTargetLabel(d.targetSystem) : target;
  const actionLabel =
    (d.targetSystem && d.actionType && getPolicyActionLabel(d.targetSystem, d.actionType)) ||
    actionLabels[action] ||
    action;
  const ariaLabel = `Action: ${targetLabel} ${actionLabel}`;
  const errorId = `action-node-error-${id}`;

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-invalid={hasErrors}
      aria-describedby={hasErrors ? errorId : undefined}
      style={{
        border: hasErrors ? `2px solid ${token.colorError}` : `1px solid ${token.colorBorder}`,
        borderRadius: 8,
        padding: '10px 14px',
        background: token.colorInfoBg,
        minWidth: 140,
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <ThunderboltOutlined style={{ color: token.colorPrimary, fontSize: 14 }} aria-hidden />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: token.colorPrimaryActive }}>
            {targetLabel}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 2 }}>
            {actionLabel}
          </div>
        </div>
        {hasErrors && (
          <Tooltip title={nodeErrors.map((e) => e.message).join(', ')}>
            <span id={errorId}>
              <ExclamationCircleOutlined
                style={{ color: token.colorError, fontSize: 14 }}
                aria-hidden
              />
            </span>
          </Tooltip>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
};

export const ActionNode = memo(ActionNodeComponent);
