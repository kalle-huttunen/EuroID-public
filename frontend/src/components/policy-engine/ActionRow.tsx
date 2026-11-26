/**
 * ActionRow — Single action row (target, type, params, remove).
 * Older policies may name Active Directory `active-directory`; the row shows it as the registry's
 * AD target and saves `ad` once the target is changed (the backend accepts both).
 */

import React from 'react';
import { Row, Col, Select, Button, Badge, Space, theme } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { AVAILABLE_ACTIONS } from './types';
import type { PolicyAction, ActionTarget, ActionType } from './types';
import type { CatalogGroup, CatalogRole } from '../../interfaces';
import { ActionParamInput } from './ActionParamInput';
import {
  ALL_SYSTEMS_TARGET,
  POLICY_ACTION_CONNECTORS,
  getPolicyTargetConnector,
} from '@features/blueprints/shared';

/**
 * Targets offered: the target connectors with policy actions in the connector registry (the same
 * ones the Design studio's node rail offers), under their registry names, then All Systems.
 */
const TARGET_OPTIONS = [
  ...POLICY_ACTION_CONNECTORS.map((c) => ({
    value: (c.id ?? c.name) as ActionTarget,
    label: c.name,
    icon: c.icon,
  })),
  { value: ALL_SYSTEMS_TARGET as ActionTarget, label: 'All Systems', icon: null },
];

interface ActionRowProps {
  action: PolicyAction;
  idx: number;
  catalogGroups: CatalogGroup[];
  catalogRoles: CatalogRole[];
  updateAction: (actionId: string, updates: Partial<PolicyAction>) => void;
  removeAction: (actionId: string) => void;
  fetchCatalog: () => void;
  fetchCatalogRoles: () => void;
  getTargetIcon: (target: ActionTarget) => React.ReactNode;
}

export const ActionRow: React.FC<ActionRowProps> = ({
  action,
  idx,
  catalogGroups,
  catalogRoles,
  updateAction,
  removeAction,
  fetchCatalog,
  fetchCatalogRoles,
  getTargetIcon,
}) => {
  const { token } = theme.useToken();
  const actionDef = AVAILABLE_ACTIONS.find((a) => a.value === action.type);

  return (
    <Row
      gutter={8}
      align="middle"
      style={{
        background: token.colorFillQuaternary,
        borderRadius: 6,
        padding: '10px 12px',
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Col flex="28px">
        <Badge count={idx + 1} style={{ backgroundColor: token.colorPrimary, fontSize: 10 }} />
      </Col>

      <Col flex="160px">
        <Select
          value={(getPolicyTargetConnector(action.target)?.id ?? action.target) as ActionTarget}
          onChange={(val) => updateAction(action.id, { target: val as ActionTarget })}
          style={{ width: '100%' }}
          size="small"
          aria-label="Target system"
          options={TARGET_OPTIONS.map((t) => ({
            value: t.value,
            label: (
              <Space>
                {t.icon ?? getTargetIcon(t.value)} {t.label}
              </Space>
            ),
          }))}
        />
      </Col>

      <Col flex="180px">
        <Select
          value={action.type}
          onChange={(val) => {
            const updates: Partial<PolicyAction> = { type: val as ActionType, params: {} };
            if (val === 'assign_role') updates.target = 'entra-id';
            updateAction(action.id, updates);
          }}
          style={{ width: '100%' }}
          size="small"
          options={Object.entries(
            AVAILABLE_ACTIONS.reduce<Record<string, typeof AVAILABLE_ACTIONS>>((acc, a) => {
              if (!acc[a.category]) acc[a.category] = [];
              acc[a.category].push(a);
              return acc;
            }, {}),
          ).map(([category, actions]) => ({
            label: category,
            options: actions.map((a) => ({ value: a.value, label: a.label })),
          }))}
        />
      </Col>

      <Col flex="auto">
        <Space size={4}>
          {actionDef?.paramsSchema.map((param) => (
            <ActionParamInput
              key={param.key}
              param={param}
              action={action}
              catalogGroups={catalogGroups}
              catalogRoles={catalogRoles}
              updateAction={updateAction}
              fetchCatalog={fetchCatalog}
              fetchCatalogRoles={fetchCatalogRoles}
            />
          ))}
        </Space>
      </Col>

      <Col flex="32px">
        <Button
          type="text"
          danger
          size="small"
          aria-label="Remove action"
          icon={<DeleteOutlined />}
          onClick={() => removeAction(action.id)}
        />
      </Col>
    </Row>
  );
};
