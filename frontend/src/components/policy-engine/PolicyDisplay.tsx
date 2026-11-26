/**
 * PolicyDisplay — Progressive disclosure for policies
 *
 * Three levels: Simple (human-readable), Advanced (rule syntax), Debug (raw JSON)
 */

import { useState } from 'react';
import { Typography, Segmented, Card, theme } from 'antd';
import { FileTextOutlined, CodeOutlined, BugOutlined } from '@ant-design/icons';
import type { Policy, ConditionGroup, PolicyAction } from './types';

export interface PolicyDisplayInput {
  name?: string;
  conditions?: Array<{ field: string; operator: string; value: string | string[] }>;
  actions?: Array<{
    type: string;
    target: string;
    value?: string;
    params?: Record<string, unknown>;
  }>;
  conditionGroups?: ConditionGroup[];
  rawJson?: Record<string, unknown>;
}

/** Names for ids in the Simple view's sentence; the Advanced and Debug views keep the ids. */
export interface PolicyDisplayLabels {
  /** e.g. assign_group -> Assign Group */
  actionType?: (type: string) => string | undefined;
  /** e.g. ad -> Active Directory */
  target?: (target: string) => string | undefined;
}

interface PolicyDisplayProps {
  /** Policy in full Policy format (conditionGroups, actions) or simplified format */
  policy: PolicyDisplayInput | Policy;
  labels?: PolicyDisplayLabels;
}

type DisplayLevel = 'simple' | 'advanced' | 'debug';

export function PolicyDisplay({ policy, labels }: PolicyDisplayProps) {
  const [level, setLevel] = useState<DisplayLevel>('simple');

  return (
    <Card size="small">
      <Segmented
        options={[
          { label: 'Simple', value: 'simple', icon: <FileTextOutlined /> },
          { label: 'Advanced', value: 'advanced', icon: <CodeOutlined /> },
          { label: 'Debug', value: 'debug', icon: <BugOutlined /> },
        ]}
        value={level}
        onChange={(v) => setLevel(v as DisplayLevel)}
        style={{ marginBottom: 16 }}
        role="radiogroup"
        aria-label="Policy display mode"
      />

      {level === 'simple' && <SimpleView policy={policy} labels={labels} />}
      {level === 'advanced' && <AdvancedView policy={policy} />}
      {level === 'debug' && <DebugView policy={policy} />}
    </Card>
  );
}

function normalizePolicy(policy: PolicyDisplayInput | Policy): {
  conditions: Array<{ field: string; operator: string; value: string }>;
  actions: Array<{ type: string; target: string; value: string }>;
  rawJson: Record<string, unknown>;
} {
  const conditions: Array<{ field: string; operator: string; value: string }> = [];
  const actions: Array<{ type: string; target: string; value: string }> = [];

  if (policy.conditionGroups) {
    policy.conditionGroups.forEach((g) => {
      g.conditions.forEach((c) => {
        conditions.push({
          field: c.field,
          operator: c.operator.replace('_', ' '),
          value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? ''),
        });
      });
    });
  } else if ('conditions' in policy && policy.conditions) {
    policy.conditions.forEach(
      (c: { field: string; operator: string; value?: string | string[] }) => {
        conditions.push({
          field: c.field,
          operator: c.operator.replace('_', ' '),
          value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? ''),
        });
      },
    );
  }

  const rawActions = policy.actions ?? [];
  rawActions.forEach(
    (
      a:
        | PolicyAction
        | { type: string; target: string; value?: string; params?: Record<string, unknown> },
    ) => {
      const params =
        (a as PolicyAction).params ?? (a as { params?: Record<string, unknown> }).params ?? {};
      const value =
        params.groupName ??
        params.roleName ??
        params.roleTemplateId ??
        params.licenseSku ??
        params.attributeValue ??
        params.mfaMethod ??
        params.policyName ??
        (a as { value?: string }).value ??
        '';
      actions.push({
        type: (a as PolicyAction).type ?? (a as { type: string }).type,
        target: (a as PolicyAction).target ?? (a as { target: string }).target ?? 'all',
        value: String(value),
      });
    },
  );

  const rawJson: Record<string, unknown> =
    'rawJson' in policy && policy.rawJson
      ? policy.rawJson
      : {
          name: (policy as Policy).name,
          conditionGroups: (policy as Policy).conditionGroups,
          actions: (policy as Policy).actions,
        };

  return { conditions, actions, rawJson };
}

/** Human-readable: "Sales Users get Salesforce" */
function SimpleView({
  policy,
  labels,
}: {
  policy: PolicyDisplayInput | Policy;
  labels?: PolicyDisplayLabels;
}) {
  const { conditions, actions } = normalizePolicy(policy);

  const conditionText =
    conditions.length > 0
      ? conditions.map((c) => `${c.field} is "${c.value}"`).join(' and ')
      : '(no conditions)';
  const actionText =
    actions.length > 0
      ? actions
          .map((a) => {
            const type = labels?.actionType?.(a.type) ?? a.type;
            const target = labels?.target?.(a.target) ?? a.target;
            // An action without a value (no group picked yet) names only what it does.
            return `${type}${a.value ? ` ${a.value}` : ''} in ${target}`;
          })
          .join(', ')
      : '(no actions)';

  return (
    <Typography.Paragraph style={{ fontSize: 16 }}>
      When <strong>{conditionText}</strong>, then <strong>{actionText}</strong>.
    </Typography.Paragraph>
  );
}

/** Rule syntax: "IF dept=Sales THEN assign group_id=123" */
function AdvancedView({ policy }: { policy: PolicyDisplayInput | Policy }) {
  const { conditions, actions } = normalizePolicy(policy);

  const conditionText =
    conditions.length > 0
      ? conditions.map((c) => `${c.field}${c.operator}${c.value}`).join(' AND ')
      : 'true';
  const actionText =
    actions.length > 0
      ? actions.map((a) => `${a.type} ${a.target}=${a.value || '—'}`).join('; ')
      : '—';

  return (
    <Typography.Text code style={{ fontSize: 14, display: 'block', whiteSpace: 'pre-wrap' }}>
      IF {conditionText} THEN {actionText}
    </Typography.Text>
  );
}

/** Raw JSON */
function DebugView({ policy }: { policy: PolicyDisplayInput | Policy }) {
  const { token } = theme.useToken();
  const { rawJson } = normalizePolicy(policy);

  return (
    <pre
      style={{
        background: token.colorFillQuaternary,
        padding: 16,
        borderRadius: 8,
        fontSize: 12,
        maxHeight: 400,
        overflow: 'auto',
      }}
    >
      {JSON.stringify(rawJson, null, 2)}
    </pre>
  );
}
