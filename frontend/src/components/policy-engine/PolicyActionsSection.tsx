/**
 * PolicyActionsSection — THEN card: role bundle link, quick-apply, action rows
 */

import React from 'react';
import { Card, Space, Select, Button, Tag, Typography, Alert, Row, Col, Badge, theme } from 'antd';
import {
  PlusOutlined,
  ThunderboltOutlined,
  AppstoreOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { AVAILABLE_ACTIONS } from './types';
import type { Policy, PolicyAction, RoleBundle, ActionTarget } from './types';
import type { CatalogGroup, CatalogRole } from '../../interfaces';
import { ActionRow } from './ActionRow';

const { Text } = Typography;

interface PolicyActionsSectionProps {
  editingPolicy: Partial<Policy>;
  setEditingPolicy: React.Dispatch<React.SetStateAction<Partial<Policy>>>;
  roleBundles: RoleBundle[];
  resolvedBundleActions: PolicyAction[];
  catalogGroups: CatalogGroup[];
  catalogRoles: CatalogRole[];
  showRoleBundles: boolean;
  setShowRoleBundles: (v: boolean) => void;
  updateAction: (actionId: string, updates: Partial<PolicyAction>) => void;
  removeAction: (actionId: string) => void;
  addAction: () => void;
  fetchCatalog: () => void;
  fetchCatalogRoles: () => void;
  getTargetIcon: (target: ActionTarget) => React.ReactNode;
  hasAnyActions: boolean;
}

export const PolicyActionsSection: React.FC<PolicyActionsSectionProps> = ({
  editingPolicy,
  setEditingPolicy,
  roleBundles,
  resolvedBundleActions,
  catalogGroups,
  catalogRoles,
  showRoleBundles,
  setShowRoleBundles,
  updateAction,
  removeAction,
  addAction,
  fetchCatalog,
  fetchCatalogRoles,
  getTargetIcon,
  hasAnyActions,
}) => {
  const { token } = theme.useToken();
  const actionCount = editingPolicy.actions?.length || 0;

  const applyRoleBundle = (bundleId: string) => {
    const bundle = roleBundles.find((rb) => rb.id === bundleId);
    if (bundle) {
      const newActions = bundle.actions.map((a) => ({
        ...a,
        id: `a-${crypto.randomUUID().slice(0, 8)}`,
      }));
      setEditingPolicy((prev) => ({
        ...prev,
        actions: [...(prev.actions || []), ...newActions],
        roleBundleId: bundleId,
      }));
      setShowRoleBundles(false);
    }
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          <ThunderboltOutlined style={{ color: token.colorPrimary }} />
          <Text strong style={{ color: token.colorPrimary }}>
            THEN
          </Text>
          <Text type="secondary">(Actions)</Text>
          <Badge
            count={actionCount + (editingPolicy.roleBundleId ? resolvedBundleActions.length : 0)}
            style={{ backgroundColor: token.colorPrimary }}
          />
        </Space>
      }
      extra={
        <Button
          type="link"
          size="small"
          icon={<AppstoreOutlined />}
          onClick={() => setShowRoleBundles(!showRoleBundles)}
        >
          {showRoleBundles ? 'Hide' : 'Apply'} Role Bundle
        </Button>
      }
      style={{
        borderColor: token.colorPrimaryBorder,
        borderLeft: `4px solid ${token.colorPrimary}`,
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
            Link Role Bundle (actions resolved at evaluation, merged with policy actions):
          </Text>
          <Select
            placeholder="Select a role bundle..."
            value={editingPolicy.roleBundleId || undefined}
            onChange={(val) =>
              setEditingPolicy((prev) => ({ ...prev, roleBundleId: val || undefined }))
            }
            onClear={() => setEditingPolicy((prev) => ({ ...prev, roleBundleId: undefined }))}
            allowClear
            style={{ width: 280 }}
            options={roleBundles.map((b) => ({ value: b.id, label: b.name }))}
          />
          {resolvedBundleActions.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 10, display: 'block', marginBottom: 4 }}>
                Resolved actions from bundle (read-only):
              </Text>
              <Space size={4} wrap>
                {resolvedBundleActions.map((a) => {
                  const actionDef = AVAILABLE_ACTIONS.find((x) => x.value === a.type);
                  const label =
                    a.params?.groupName ||
                    a.params?.roleName ||
                    a.params?.licenseSku ||
                    a.params?.mfaMethod ||
                    a.params?.policyName ||
                    actionDef?.label ||
                    a.type;
                  return (
                    <Tag key={a.id} style={{ fontSize: 10 }}>
                      {a.target}: {label}
                    </Tag>
                  );
                })}
              </Space>
            </div>
          )}
        </div>

        {showRoleBundles && (
          <Card size="small" style={{ background: token.colorPrimaryBg, borderStyle: 'dashed' }}>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
              Quick-apply a pre-configured role bundle:
            </Text>
            <Row gutter={[8, 8]}>
              {roleBundles.map((bundle) => (
                <Col key={bundle.id} span={12}>
                  <Button
                    block
                    size="small"
                    style={{
                      textAlign: 'left',
                      height: 'auto',
                      padding: '8px 12px',
                      borderColor: bundle.color,
                    }}
                    onClick={() => applyRoleBundle(bundle.id)}
                  >
                    <Space direction="vertical" size={0}>
                      <Text strong style={{ fontSize: 12, color: bundle.color }}>
                        {bundle.name}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 10 }}>
                        {bundle.actions.length} actions • {(bundle.description ?? '').slice(0, 50)}
                        ...
                      </Text>
                    </Space>
                  </Button>
                </Col>
              ))}
            </Row>
          </Card>
        )}

        {editingPolicy.actions?.map((action, idx) => (
          <ActionRow
            key={action.id}
            action={action}
            idx={idx}
            catalogGroups={catalogGroups}
            catalogRoles={catalogRoles}
            updateAction={updateAction}
            removeAction={removeAction}
            fetchCatalog={fetchCatalog}
            fetchCatalogRoles={fetchCatalogRoles}
            getTargetIcon={getTargetIcon}
          />
        ))}

        <Button type="dashed" icon={<PlusOutlined />} onClick={() => addAction()} block>
          Add Action
        </Button>

        {!hasAnyActions && (
          <Alert
            message="No actions defined"
            description="Link a Role Bundle above, add actions manually, or quick-apply a Role Bundle to get started."
            type="info"
            showIcon
            icon={<InfoCircleOutlined />}
          />
        )}
      </Space>
    </Card>
  );
};
