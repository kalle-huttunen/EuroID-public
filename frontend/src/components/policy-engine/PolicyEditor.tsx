/**
 * PolicyEditor - Visual Condition Builder
 *
 * A visual IF-THEN policy editor with:
 * - Condition builder: Select field → operator → value
 * - AND/OR group logic
 * - Action configuration with target system selection
 * - Role bundle quick-apply
 * - Live preview of affected users
 *
 * Design: Card-based builder (inspired by Notion filters / Zapier)
 */

import React, { useState } from 'react';
import { Card, Collapse, Space, Typography, Badge, theme } from 'antd';
import { CodeOutlined } from '@ant-design/icons';
import {
  ArrowRightOutlined,
  BranchesOutlined,
  ApartmentOutlined,
  SafetyCertificateOutlined,
  CloudOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { useList } from '@api/resource-hooks';
import {
  Policy,
  PolicyCondition,
  ConditionGroup,
  PolicyAction,
  ActionTarget,
  ActionType,
  type RoleBundle,
} from './types';
import { ConditionGroupEditor } from './ConditionGroupEditor';
import { PolicyHeaderCard } from './PolicyHeaderCard';
import { PolicyFooterCard } from './PolicyFooterCard';
import { PolicyActionsSection } from './PolicyActionsSection';
import { usePolicyCatalog } from './hooks/usePolicyCatalog';

const { Text } = Typography;

interface Props {
  policy?: Policy | null;
  onSave: (policy: Partial<Policy>) => void;
  onCancel: () => void;
  onPreview: (policy: Partial<Policy>) => void;
}

function toRegoPreview(groups: ConditionGroup[], actions: PolicyAction[]): string {
  const lines: string[] = ['package euroid.policy', '', 'default allow := false', ''];
  if (groups.length === 0) return lines.join('\n') + '# No conditions defined\n';

  lines.push('allow if {');
  groups.forEach((group, gi) => {
    if (gi > 0) lines.push('');
    if (group.join === 'OR' && group.conditions.length > 1) {
      lines.push(`    group_${gi}_match`);
    } else {
      group.conditions.forEach((c) => {
        const field = c.field || '_';
        const val = Array.isArray(c.value) ? JSON.stringify(c.value) : `"${c.value}"`;
        switch (c.operator) {
          case 'equals': lines.push(`    input.user.${field} == ${val}`); break;
          case 'not_equals': lines.push(`    input.user.${field} != ${val}`); break;
          case 'contains': lines.push(`    contains(input.user.${field}, ${val})`); break;
          case 'starts_with': lines.push(`    startswith(input.user.${field}, ${val})`); break;
          case 'ends_with': lines.push(`    endswith(input.user.${field}, ${val})`); break;
          case 'in': lines.push(`    input.user.${field} in ${val}`); break;
          case 'not_in': lines.push(`    not input.user.${field} in ${val}`); break;
          case 'greater_than': lines.push(`    input.user.${field} > ${c.value}`); break;
          case 'less_than': lines.push(`    input.user.${field} < ${c.value}`); break;
          case 'is_empty': lines.push(`    input.user.${field} == ""`); break;
          case 'is_not_empty': lines.push(`    input.user.${field} != ""`); break;
          case 'regex': lines.push(`    regex.match(${val}, input.user.${field})`); break;
          default: lines.push(`    # ${field} ${c.operator} ${val}`);
        }
      });
    }
  });
  lines.push('}');

  // OR group helper rules
  groups.forEach((group, gi) => {
    if (group.join === 'OR' && group.conditions.length > 1) {
      lines.push('');
      group.conditions.forEach((c) => {
        const field = c.field || '_';
        const val = Array.isArray(c.value) ? JSON.stringify(c.value) : `"${c.value}"`;
        lines.push(`group_${gi}_match if {`);
        lines.push(`    input.user.${field} == ${val}`);
        lines.push('}');
      });
    }
  });

  if (actions.length > 0) {
    lines.push('');
    lines.push('# ── Actions ──');
    actions.forEach((a) => {
      const params = Object.entries(a.params || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
      lines.push(`# → ${a.type} on ${a.target}${params ? ` (${params})` : ''}`);
    });
  }

  return lines.join('\n');
}

function nextConditionId() {
  return `c-${crypto.randomUUID().slice(0, 8)}`;
}

function createDefaultPolicy(): Partial<Policy> {
  const id = nextConditionId();
  return {
    name: '',
    description: '',
    status: 'active',
    priority: 3,
    risk: 'Low',
    conditionGroups: [
      {
        id: `cg-${id}`,
        join: 'AND',
        conditions: [{ id, field: '', operator: 'equals', value: '' }],
      },
    ],
    actions: [],
    tags: [],
  };
}

export const PolicyEditor: React.FC<Props> = ({ policy, onSave, onCancel, onPreview }) => {
  const { token } = theme.useToken();
  const [editingPolicy, setEditingPolicy] = useState<Partial<Policy>>(
    policy ? { ...policy } : createDefaultPolicy(),
  );
  const [showRoleBundles, setShowRoleBundles] = useState(false);

  const { catalogGroups, catalogRoles, resolvedBundleActions, fetchCatalog, fetchCatalogRoles } =
    usePolicyCatalog(editingPolicy.roleBundleId);

  const isNew = !policy;

  // --- Condition Handlers ---

  const updateConditionGroup = (groupId: string, updates: Partial<ConditionGroup>) => {
    setEditingPolicy((prev) => ({
      ...prev,
      conditionGroups: prev.conditionGroups?.map((cg) =>
        cg.id === groupId ? { ...cg, ...updates } : cg,
      ),
    }));
  };

  const updateCondition = (
    groupId: string,
    conditionId: string,
    updates: Partial<PolicyCondition>,
  ) => {
    setEditingPolicy((prev) => ({
      ...prev,
      conditionGroups: prev.conditionGroups?.map((cg) =>
        cg.id === groupId
          ? {
              ...cg,
              conditions: cg.conditions.map((c) =>
                c.id === conditionId ? { ...c, ...updates } : c,
              ),
            }
          : cg,
      ),
    }));
  };

  const addCondition = (groupId: string) => {
    const newCondition: PolicyCondition = {
      id: nextConditionId(),
      field: '',
      operator: 'equals',
      value: '',
    };
    setEditingPolicy((prev) => ({
      ...prev,
      conditionGroups: prev.conditionGroups?.map((cg) =>
        cg.id === groupId ? { ...cg, conditions: [...cg.conditions, newCondition] } : cg,
      ),
    }));
  };

  const removeCondition = (groupId: string, conditionId: string) => {
    setEditingPolicy((prev) => ({
      ...prev,
      conditionGroups: prev.conditionGroups?.map((cg) =>
        cg.id === groupId
          ? { ...cg, conditions: cg.conditions.filter((c) => c.id !== conditionId) }
          : cg,
      ),
    }));
  };

  const reorderCondition = (groupId: string, oldIndex: number, newIndex: number) => {
    setEditingPolicy((prev) => ({
      ...prev,
      conditionGroups: prev.conditionGroups?.map((cg) => {
        if (cg.id !== groupId) return cg;
        const items = [...cg.conditions];
        const [moved] = items.splice(oldIndex, 1);
        items.splice(newIndex, 0, moved);
        return { ...cg, conditions: items };
      }),
    }));
  };

  // --- Action Handlers ---

  const addAction = (actionType?: string, target?: ActionTarget) => {
    const newAction: PolicyAction = {
      id: `a-${crypto.randomUUID().slice(0, 8)}`,
      type: (actionType as ActionType) || 'assign_group',
      target: target || 'entra-id',
      params: {},
    };
    setEditingPolicy((prev) => ({
      ...prev,
      actions: [...(prev.actions || []), newAction],
    }));
  };

  const updateAction = (actionId: string, updates: Partial<PolicyAction>) => {
    setEditingPolicy((prev) => ({
      ...prev,
      actions: prev.actions?.map((a) => (a.id === actionId ? { ...a, ...updates } : a)),
    }));
  };

  const removeAction = (actionId: string) => {
    setEditingPolicy((prev) => ({
      ...prev,
      actions: prev.actions?.filter((a) => a.id !== actionId),
    }));
  };

  const { data: bundlesData } = useList<RoleBundle>({ resource: 'role-bundles' });
  const roleBundles: RoleBundle[] = bundlesData?.data ?? [];

  const getTargetIcon = (target: ActionTarget) => {
    const map: Record<string, React.ReactNode> = {
      'active-directory': <ApartmentOutlined style={{ color: token.colorPrimary }} />,
      'entra-id': <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />,
      salesforce: <CloudOutlined style={{ color: token.colorInfo }} />,
      all: <AppstoreOutlined />,
    };
    return map[target] || null;
  };

  // --- Render ---

  const conditionCount =
    editingPolicy.conditionGroups?.reduce((sum, cg) => sum + cg.conditions.length, 0) || 0;
  const actionCount = editingPolicy.actions?.length || 0;
  const hasAnyActions = actionCount > 0 || !!editingPolicy.roleBundleId;

  const canSave = !!editingPolicy.name?.trim() && conditionCount > 0 && hasAnyActions;
  const missingReasons: string[] = [];
  if (!editingPolicy.name?.trim()) missingReasons.push('a policy name');
  if (conditionCount === 0) missingReasons.push('at least one condition');
  if (!hasAnyActions) missingReasons.push('at least one action or a linked role bundle');
  const saveDisabledHint =
    missingReasons.length > 0
      ? `Add ${missingReasons.join(', ').replace(/, ([^,]+)$/, ', and $1')} to save`
      : null;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <PolicyHeaderCard editingPolicy={editingPolicy} setEditingPolicy={setEditingPolicy} />

      {/* ═══════ IF Section (Conditions) ═══════ */}
      <Card
        size="small"
        title={
          <Space>
            <BranchesOutlined style={{ color: token.colorInfo }} />
            <Text strong style={{ color: token.colorInfo }}>
              IF
            </Text>
            <Text type="secondary">(Conditions)</Text>
            <Badge count={conditionCount} style={{ backgroundColor: token.colorInfo }} />
          </Space>
        }
        style={{ borderColor: token.colorInfoBorder, borderLeft: `4px solid ${token.colorInfo}` }}
      >
        <ConditionGroupEditor
          conditionGroups={editingPolicy.conditionGroups ?? []}
          updateConditionGroup={updateConditionGroup}
          updateCondition={updateCondition}
          addCondition={addCondition}
          removeCondition={removeCondition}
          reorderCondition={reorderCondition}
        />
        <Collapse
          ghost
          size="small"
          style={{ marginTop: 12 }}
          items={[{
            key: 'rego',
            label: (
              <Space size={4}>
                <CodeOutlined />
                <Text type="secondary" style={{ fontSize: 12 }}>Rego Preview</Text>
              </Space>
            ),
            children: (
              <pre style={{
                background: token.colorFillQuaternary,
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                fontFamily: token.fontFamilyCode,
                overflow: 'auto',
                maxHeight: 200,
                margin: 0,
              }}>
                {toRegoPreview(editingPolicy.conditionGroups ?? [], editingPolicy.actions ?? [])}
              </pre>
            ),
          }]}
        />
      </Card>

      {/* Arrow */}
      <div style={{ textAlign: 'center' }}>
        <ArrowRightOutlined
          style={{ fontSize: 24, color: token.colorPrimary, transform: 'rotate(90deg)' }}
        />
      </div>

      <PolicyActionsSection
        editingPolicy={editingPolicy}
        setEditingPolicy={setEditingPolicy}
        roleBundles={roleBundles}
        resolvedBundleActions={resolvedBundleActions}
        catalogGroups={catalogGroups}
        catalogRoles={catalogRoles}
        showRoleBundles={showRoleBundles}
        setShowRoleBundles={setShowRoleBundles}
        updateAction={updateAction}
        removeAction={removeAction}
        addAction={() => addAction()}
        fetchCatalog={fetchCatalog}
        fetchCatalogRoles={fetchCatalogRoles}
        getTargetIcon={getTargetIcon}
        hasAnyActions={hasAnyActions}
      />

      <PolicyFooterCard
        conditionCount={conditionCount}
        actionCount={actionCount}
        resolvedBundleCount={editingPolicy.roleBundleId ? resolvedBundleActions.length : 0}
        hasAnyActions={hasAnyActions}
        canSave={canSave}
        saveDisabledHint={saveDisabledHint}
        isNew={isNew}
        editingPolicy={editingPolicy}
        onSave={onSave}
        onCancel={onCancel}
        onPreview={onPreview}
      />
    </Space>
  );
};
