/**
 * ActionParamInput — Conditional param rendering for policy actions
 * Handles group select, role select, license select (catalog licenses), attribute input,
 * discovery buttons.
 */

import React from 'react';
import { Space, Select, Input, Button, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { SEMANTIC, BRAND } from '../../theme/themeConfig';
import { AVAILABLE_ACTIONS } from './types';
import type { PolicyAction } from './types';
import { LicenseSkuSelect } from './LicenseSkuSelect';
import type { CatalogGroup, CatalogRole } from '../../interfaces';

const { Text } = Typography;
const CONNECTORS_API = `${API_BASE}/connectors`;

const TARGET_TO_SYSTEM: Record<string, string> = {
  'entra-id': 'entra-id',
  ad: 'ad',
  'active-directory': 'ad',
};

interface ActionParamInputProps {
  param: { key: string; label: string; type: string; options?: string[] };
  action: PolicyAction;
  catalogGroups: CatalogGroup[];
  catalogRoles: CatalogRole[];
  updateAction: (actionId: string, updates: Partial<PolicyAction>) => void;
  fetchCatalog: () => void;
  fetchCatalogRoles: () => void;
}

export const ActionParamInput: React.FC<ActionParamInputProps> = ({
  param,
  action,
  catalogGroups,
  catalogRoles,
  updateAction,
  fetchCatalog,
  fetchCatalogRoles,
}) => {
  const actionDef = AVAILABLE_ACTIONS.find((a) => a.value === action.type);
  const isAssignRoleEntra =
    actionDef?.value === 'assign_role' && action.target === 'entra-id' && param.key === 'roleName';
  if (actionDef?.value === 'assign_role' && param.key === 'roleTemplateId') return null;

  const isAssignGroupEntra =
    actionDef?.value === 'assign_group' &&
    (action.target === 'entra-id' || TARGET_TO_SYSTEM[action.target] === 'ad') &&
    param.key === 'groupName';
  const currentGroup = action.params[param.key] as string | undefined;
  const catalogSystem = TARGET_TO_SYSTEM[action.target] ?? action.target;
  const systemGroups = catalogGroups.filter((g) => g.system === catalogSystem);
  const groupOptions: { value: string; label: string }[] = systemGroups.map((g) => ({
    value: g.nativeId,
    label: g.name,
  }));

  if (currentGroup && typeof currentGroup === 'string') {
    const byId = catalogGroups.find((g) => g.nativeId === currentGroup);
    const byName = catalogGroups.find((g) => g.name === currentGroup && g.system === catalogSystem);
    const resolved = byId ?? byName;
    if (resolved && !groupOptions.some((o) => o.value === resolved.nativeId)) {
      groupOptions.unshift({ value: resolved.nativeId, label: resolved.name });
    } else if (!resolved && !groupOptions.some((o) => o.value === currentGroup)) {
      groupOptions.unshift({ value: currentGroup, label: `${currentGroup} (legacy)` });
    }
  }

  const displayValue = currentGroup
    ? (catalogGroups.find((g) => g.nativeId === currentGroup || g.name === currentGroup)
        ?.nativeId ?? currentGroup)
    : undefined;

  if (isAssignRoleEntra) {
    const currentRoleId = action.params.roleTemplateId as string | undefined;
    const currentRoleName = action.params.roleName as string | undefined;
    const roleOptions = catalogRoles.map((r) => ({
      value: r.nativeId,
      label: r.name,
      adminTier: r.adminTier,
    }));
    const tierColor = (tier: string | undefined) => {
      if (tier === 'TIER_0') return SEMANTIC.statusError;
      if (tier === 'TIER_1') return SEMANTIC.statusDriftText;
      if (tier === 'TIER_2') return BRAND.warningText;
      return undefined;
    };
    if (catalogRoles.length > 0) {
      const roleDisplayValue =
        currentRoleId ??
        (currentRoleName && catalogRoles.find((r) => r.name === currentRoleName)?.nativeId);
      return (
        <Space key={param.key} direction="vertical" size={0}>
          <Select
            value={roleDisplayValue}
            onChange={(val) => {
              const role = catalogRoles.find((r) => r.nativeId === val);
              updateAction(action.id, {
                params: {
                  ...action.params,
                  roleName: role?.name ?? val,
                  roleTemplateId: val,
                },
              });
            }}
            placeholder="Select directory role..."
            size="small"
            style={{ minWidth: 200 }}
            options={roleOptions}
            showSearch
            optionFilterProp="label"
            optionRender={(opt) => {
              const data = opt as { label: React.ReactNode; adminTier?: string };
              return (
                <Space>
                  <Text strong style={{ fontSize: 12 }}>
                    {data.label}
                  </Text>
                  {data.adminTier && (
                    <Tag color={tierColor(data.adminTier)} style={{ fontSize: 10 }}>
                      {data.adminTier}
                    </Tag>
                  )}
                </Space>
              );
            }}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {catalogRoles.length} role{catalogRoles.length !== 1 ? 's' : ''} available
          </Text>
        </Space>
      );
    }
    return (
      <Space key={param.key} direction="vertical" size={0}>
        <Input
          placeholder="No roles discovered — run discovery first"
          value={currentRoleName ?? ''}
          onChange={(e) =>
            updateAction(action.id, { params: { ...action.params, roleName: e.target.value } })
          }
          size="small"
          style={{ minWidth: 200 }}
        />
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Run Entra connector discovery to populate directory roles
          </Text>
          <Button
            type="link"
            size="small"
            icon={<ReloadOutlined />}
            onClick={() =>
              axiosInstance
                .post(`${CONNECTORS_API}/entra-id/discover`)
                .then(() => fetchCatalogRoles())
                .catch(() => {})
            }
            style={{ padding: 0, height: 'auto' }}
          >
            Run Discovery
          </Button>
        </Space>
      </Space>
    );
  }

  if (actionDef?.value === 'assign_license' && param.key === 'licenseSku') {
    return (
      <LicenseSkuSelect
        key={param.key}
        value={action.params.licenseSku as string | undefined}
        onChange={(sku) =>
          updateAction(action.id, { params: { ...action.params, licenseSku: sku } })
        }
      />
    );
  }

  if (isAssignGroupEntra && groupOptions.length > 0) {
    return (
      <Space key={param.key} direction="vertical" size={0}>
        <Select
          value={displayValue}
          onChange={(val) =>
            updateAction(action.id, { params: { ...action.params, [param.key]: val } })
          }
          placeholder={param.label}
          size="small"
          style={{ minWidth: 200 }}
          options={groupOptions}
          showSearch
          optionFilterProp="label"
          optionRender={(opt) => (
            <Space direction="vertical" size={0}>
              <Text strong style={{ fontSize: 12 }}>
                {opt.data?.label}
              </Text>
              <Text type="secondary" style={{ fontSize: 10 }}>
                {opt.value}
              </Text>
            </Space>
          )}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          {systemGroups.length} group{systemGroups.length !== 1 ? 's' : ''} available
        </Text>
      </Space>
    );
  }

  if (isAssignGroupEntra && groupOptions.length === 0) {
    const runDiscovery = () => {
      axiosInstance
        .post(`${CONNECTORS_API}/${catalogSystem}/discover`)
        .then(() => fetchCatalog())
        .catch(() => {});
    };
    return (
      <Space key={param.key} direction="vertical" size={0}>
        <Input
          placeholder="No groups discovered — enter group ID manually"
          value={currentGroup ?? ''}
          onChange={(e) =>
            updateAction(action.id, { params: { ...action.params, [param.key]: e.target.value } })
          }
          size="small"
          style={{ minWidth: 200 }}
        />
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Run connector discovery to populate group list
          </Text>
          <Button
            type="link"
            size="small"
            icon={<ReloadOutlined />}
            onClick={runDiscovery}
            style={{ padding: 0, height: 'auto' }}
          >
            Run Discovery
          </Button>
        </Space>
      </Space>
    );
  }

  if (param.type === 'select' && param.options) {
    return (
      <Select
        key={param.key}
        value={action.params[param.key] || undefined}
        onChange={(val) =>
          updateAction(action.id, { params: { ...action.params, [param.key]: val } })
        }
        placeholder={param.label}
        size="small"
        style={{ minWidth: 130 }}
        options={param.options.map((o) => ({ value: o, label: o }))}
      />
    );
  }

  return (
    <Input
      key={param.key}
      value={action.params[param.key] || ''}
      onChange={(e) =>
        updateAction(action.id, { params: { ...action.params, [param.key]: e.target.value } })
      }
      placeholder={param.label}
      size="small"
      style={{ minWidth: 120 }}
    />
  );
};
