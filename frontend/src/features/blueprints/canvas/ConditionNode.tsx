/**
 * ConditionNode — Visual policy condition (field, operator, value).
 * Red border when validation errors exist. Source handle on right.
 */
import React, { memo } from 'react';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { Tooltip, theme } from 'antd';
import { FilterOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { usePolicyDraftStore } from '@stores/policy-draft-store';

interface ConditionNodeData {
  [key: string]: unknown;
  field?: string;
  operator?: string;
  value?: string;
}

const ConditionNodeComponent: React.FC<NodeProps<Node<ConditionNodeData, 'condition'>>> = ({
  id,
  data,
}) => {
  const { token } = theme.useToken();
  const validationErrors = usePolicyDraftStore((s) => s.validationErrors);
  const nodeErrors = validationErrors.filter((e) => e.nodeId === id);
  const hasErrors = nodeErrors.length > 0;

  const d = data as ConditionNodeData;
  const field = d.field || 'field';
  const operator = d.operator || 'equals';
  const value = d.value ?? '...';
  const ariaLabel = `Condition: ${field} ${operator} ${value || '—'}`;
  const errorId = `condition-node-error-${id}`;

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
        background: token.colorSuccessBg,
        minWidth: 140,
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <FilterOutlined style={{ color: token.colorSuccess, fontSize: 14 }} aria-hidden />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: token.colorSuccessActive }}>
            {field} {operator}
          </div>
          <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 2 }}>{value || '—'}</div>
        </div>
        {hasErrors && (
          <Tooltip title={nodeErrors.map((e) => e.message).join(', ')}>
            <span id={errorId}>
              <ExclamationCircleOutlined style={{ color: token.colorError, fontSize: 14 }} aria-hidden />
            </span>
          </Tooltip>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
};

export const ConditionNode = memo(ConditionNodeComponent);
