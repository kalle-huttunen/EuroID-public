/**
 * PolicyList - Policy Dashboard
 *
 * Displays all policies in a sortable, filterable list with:
 * - Enable/disable toggle; a draft goes live through Activate (PolicyStatusCell)
 * - Priority indicators
 * - Risk level badges
 * - Affected user counts (via TanStack Query parallel fetches)
 * - Grants reviewers revoked in access reviews (review exclusions per granting policy), so a
 *   policy reviewers keep overriding stands out for redesign
 * - Quick actions (edit, duplicate, delete)
 */

import React, { useState, useMemo } from 'react';
import type { MenuInfo } from 'rc-menu/lib/interface';
import {
  Card,
  Table,
  Tag,
  Space,
  Button,
  Badge,
  Typography,
  Input,
  Select,
  Statistic,
  Row,
  Col,
  Tooltip,
  Dropdown,
  Spin,
  notification,
  App,
  theme,
} from 'antd';
import {
  ThunderboltOutlined,
  SearchOutlined,
  PlusOutlined,
  EditOutlined,
  CopyOutlined,
  DeleteOutlined,
  EyeOutlined,
  MoreOutlined,
  CheckCircleOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  UserOutlined,
  HistoryOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { Policy, RiskLevel } from './types';
import type { IPolicyReviewExclusionCount } from '../../interfaces';
import { usePermission, useAuthContext } from '../../auth';
import {
  usePolicies,
  usePolicyImpactCounts,
  useActivatePolicy,
  useTogglePolicy,
  useDeletePolicy,
  useDuplicatePolicy,
  useUpdatePolicyPriority,
} from '@api/policy-api';
import { useReviewExclusionCounts } from '@api/review-exclusions-api';
import { BRAND } from '../../theme';
import { apiErrorMessage } from '../../features/dead-letter/dead-letter-labels';
import { PolicyStatusCell } from './PolicyStatusCell';

const { Text } = Typography;

interface Props {
  onEditPolicy: (policy: Policy) => void;
  onPreviewPolicy: (policy: Policy) => void;
  onCreatePolicy: () => void;
  onRefresh?: () => void;
}

/** How often reviewers revoked access the policy grants (access review exclusions), if ever. */
const RevokedInReviews: React.FC<{ count?: IPolicyReviewExclusionCount }> = ({ count }) => {
  const { token } = theme.useToken();
  const total = count ? count.active + count.lifted : 0;
  if (!count || total === 0) return null;
  return (
    <Tooltip
      title={
        `Reviewers revoked access this policy grants ${total} time(s) in access reviews: ` +
        `${count.active} still excluded, ${count.lifted} lifted.`
      }
    >
      <Text style={{ fontSize: 10, whiteSpace: 'nowrap', color: token.colorWarningText }}>
        <StopOutlined /> {total} revoked in reviews
      </Text>
    </Tooltip>
  );
};

const RISK_COLOR: Record<RiskLevel, string> = {
  Low: 'blue',
  Medium: 'orange',
  High: 'red',
  Critical: 'magenta',
};

export const PolicyList: React.FC<Props> = ({ onEditPolicy, onPreviewPolicy, onCreatePolicy }) => {
  const { token } = theme.useToken();
  const canEditPolicy = usePermission('policy-admin');
  const myEmail = useAuthContext().user?.profile?.email;
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [api, contextHolder] = notification.useNotification();
  // App.useApp's modal follows the app's theme; a static Modal.confirm renders outside it.
  const { modal } = App.useApp();

  // ── Data fetching via TanStack Query ────────────────────────
  const { data: policies = [], isLoading, refetch } = usePolicies();
  const policyIds = useMemo(() => policies.map((p) => p.id), [policies]);
  const impactQueries = usePolicyImpactCounts(policyIds);
  const { data: exclusionCounts } = useReviewExclusionCounts();

  const impactCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    policyIds.forEach((id, i) => {
      counts[id] = (impactQueries[i]?.data as number) ?? 0;
    });
    return counts;
  }, [policyIds, impactQueries]);

  // ── Mutations ───────────────────────────────────────────────
  const activateMutation = useActivatePolicy();
  const toggleMutation = useTogglePolicy();
  const deleteMutation = useDeletePolicy();
  const duplicateMutation = useDuplicatePolicy();
  const priorityMutation = useUpdatePolicyPriority();

  const handleToggleStatus = (policyId: string) => {
    toggleMutation.mutate(policyId, {
      onError: () => api.error({ message: 'Toggle failed', placement: 'top' }),
    });
  };

  const confirmActivate = (policy: Policy) => {
    // Undefined while the impact count is still loading (or failed): the dialog then names none.
    const matched = impactQueries[policyIds.indexOf(policy.id)]?.data as number | undefined;
    modal.confirm({
      title: 'Activate this policy?',
      content:
        `"${policy.name}" goes live: the policy engine applies its actions to the identities ` +
        'it matches.' +
        (matched === undefined
          ? ''
          : ` It matches ${matched} ${matched === 1 ? 'identity' : 'identities'} now.`),
      okText: 'Activate',
      cancelText: 'Cancel',
      onOk: () =>
        activateMutation.mutate(policy.id, {
          onSuccess: () =>
            api.success({
              message: 'Policy activated',
              description: `"${policy.name}" is live.`,
              placement: 'top',
            }),
          onError: (err) =>
            api.error({
              message: 'Activation refused',
              description: apiErrorMessage(err, 'The activation failed.'),
              placement: 'top',
            }),
        }),
    });
  };

  const handleDelete = (policyId: string) => {
    deleteMutation.mutate(policyId, {
      onSuccess: () => api.success({ message: 'Policy deleted', placement: 'top' }),
      onError: () => api.error({ message: 'Delete failed', placement: 'top' }),
    });
  };

  const handleDuplicate = (policy: Policy) => {
    duplicateMutation.mutate(policy, {
      onSuccess: () => api.success({ message: 'Policy duplicated', placement: 'top' }),
      onError: () => api.error({ message: 'Duplicate failed', placement: 'top' }),
    });
  };

  const handleMovePriority = (policyId: string, direction: 'up' | 'down') => {
    const policy = policies.find((p) => p.id === policyId);
    if (!policy) return;
    const newPriority =
      direction === 'up' ? Math.max(1, policy.priority - 1) : Math.min(5, policy.priority + 1);
    priorityMutation.mutate({ policyId, priority: newPriority });
  };

  // ── Filters ─────────────────────────────────────────────────
  const filteredPolicies = useMemo(
    () =>
      policies
        .filter((p) => {
          const matchesSearch =
            p.name.toLowerCase().includes(searchText.toLowerCase()) ||
            p.description.toLowerCase().includes(searchText.toLowerCase());
          const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
          return matchesSearch && matchesStatus;
        })
        .sort((a, b) => a.priority - b.priority),
    [policies, searchText, statusFilter],
  );

  const getAffected = (p: Policy) => impactCounts[p.id] ?? p.affectedUsers ?? 0;
  const activePolicies = policies.filter((p) => p.status === 'active').length;
  const totalAffected = policies.reduce((sum, p) => sum + getAffected(p), 0);
  const highRiskPolicies = policies.filter(
    (p) => p.risk === 'High' || p.risk === 'Critical',
  ).length;

  // ── Columns ─────────────────────────────────────────────────
  const columns = [
    {
      title: '',
      key: 'priority',
      width: 50,
      render: (_: unknown, record: Policy) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'center' }}>
          {canEditPolicy && (
            <Button
              type="text"
              size="small"
              aria-label="Raise priority"
              icon={<ArrowUpOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                handleMovePriority(record.id, 'up');
              }}
              disabled={record.priority <= 1}
              style={{ padding: 0, height: 18 }}
            />
          )}
          <Tooltip title={`Priority ${record.priority}`}>
            <Badge
              count={`P${record.priority}`}
              style={{
                backgroundColor:
                  record.priority <= 2
                    ? token.colorPrimary
                    : record.priority <= 3
                      ? BRAND.warningText
                      : token.colorBorder,
                fontSize: 10,
              }}
            />
          </Tooltip>
          {canEditPolicy && (
            <Button
              type="text"
              size="small"
              aria-label="Lower priority"
              icon={<ArrowDownOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                handleMovePriority(record.id, 'down');
              }}
              disabled={record.priority >= 5}
              style={{ padding: 0, height: 18 }}
            />
          )}
        </Space>
      ),
    },
    {
      title: 'Policy',
      key: 'name',
      width: '35%',
      render: (_: unknown, record: Policy) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
              {record.name}
            </Text>
            {record.tags?.map((tag) => (
              <Tag key={tag} style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>
                {tag}
              </Tag>
            ))}
          </div>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }} ellipsis>
            {record.description}
          </Text>
          <Space size={12} style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
              <UserOutlined /> {getAffected(record)} users
            </Text>
            <Text type="secondary" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
              <HistoryOutlined /> {record.totalExecutions || 0} runs
            </Text>
            {record.lastTriggered && (
              <Text type="secondary" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                Last: {new Date(record.lastTriggered).toLocaleDateString()}
              </Text>
            )}
            <RevokedInReviews count={exclusionCounts?.[record.id]} />
          </Space>
        </div>
      ),
    },
    {
      title: 'Conditions',
      key: 'conditions',
      width: 180,
      render: (_: unknown, record: Policy) => (
        <Space direction="vertical" size={2}>
          {record.conditionGroups.flatMap((cg) =>
            cg.conditions.slice(0, 2).map((c) => (
              <Text key={c.id} code style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                {c.field} {c.operator.replace('_', ' ')} &quot;
                {Array.isArray(c.value) ? c.value.join(', ') : c.value}&quot;
              </Text>
            )),
          )}
          {record.conditionGroups.length > 0 && record.conditionGroups[0].conditions.length > 1 && (
            <Tag color="purple" style={{ fontSize: 9 }}>
              {record.conditionGroups[0].join}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Actions',
      key: 'policyActions',
      width: 200,
      render: (_: unknown, record: Policy) => (
        <Space direction="vertical" size={2}>
          {record.actions.slice(0, 2).map((a) => {
            const targetColor =
              a.target === 'active-directory'
                ? 'blue'
                : a.target === 'entra-id'
                  ? 'purple'
                  : a.target === 'salesforce'
                    ? 'cyan'
                    : 'default';
            return (
              <Space key={a.id} size={4} style={{ flexWrap: 'nowrap' }}>
                <Tag
                  color={targetColor}
                  style={{ fontSize: 10, lineHeight: '16px', whiteSpace: 'nowrap' }}
                >
                  {a.target}
                </Tag>
                <Text style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{a.label || a.type}</Text>
              </Space>
            );
          })}
          {record.actions.length > 2 && (
            <Text type="secondary" style={{ fontSize: 10 }}>
              +{record.actions.length - 2} more
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Risk',
      key: 'risk',
      width: 80,
      render: (_: unknown, record: Policy) => (
        <Tag color={RISK_COLOR[record.risk]}>{record.risk}</Tag>
      ),
    },
    {
      title: '',
      key: 'status',
      // Room for a draft's toggle and Activate on one line; kept in view on a narrow screen.
      width: 140,
      fixed: 'right' as const,
      render: (_: unknown, record: Policy) => (
        <PolicyStatusCell
          policy={record}
          canEdit={canEditPolicy}
          myEmail={myEmail}
          activating={activateMutation.isPending && activateMutation.variables === record.id}
          onToggle={(policy) => handleToggleStatus(policy.id)}
          onActivate={confirmActivate}
        />
      ),
    },
    {
      title: '',
      key: 'rowActions',
      width: 40,
      fixed: 'right' as const,
      render: (_: unknown, record: Policy) => {
        const items = canEditPolicy
          ? [
              {
                key: 'edit',
                label: 'Edit Policy',
                icon: <EditOutlined />,
                onClick: (info: MenuInfo) => {
                  info.domEvent.stopPropagation();
                  onEditPolicy(record);
                },
              },
              {
                key: 'preview',
                label: 'Preview Impact',
                icon: <EyeOutlined />,
                onClick: (info: MenuInfo) => {
                  info.domEvent.stopPropagation();
                  onPreviewPolicy(record);
                },
              },
              {
                key: 'duplicate',
                label: 'Duplicate',
                icon: <CopyOutlined />,
                onClick: (info: MenuInfo) => {
                  info.domEvent.stopPropagation();
                  handleDuplicate(record);
                },
              },
              { type: 'divider' as const },
              {
                key: 'delete',
                label: 'Delete',
                icon: <DeleteOutlined />,
                danger: true,
                onClick: (info: MenuInfo) => {
                  info.domEvent.stopPropagation();
                  modal.confirm({
                    title: 'Delete this policy?',
                    content: `"${record.name}" will be permanently removed.`,
                    okText: 'Delete',
                    okType: 'danger',
                    cancelText: 'Cancel',
                    onOk: () => handleDelete(record.id),
                  });
                },
              },
            ]
          : [
              {
                key: 'preview',
                label: 'Preview Impact',
                icon: <EyeOutlined />,
                onClick: () => onPreviewPolicy(record),
              },
            ];
        return (
          <Dropdown
            menu={{ items }}
            trigger={['click']}
            placement="bottomRight"
            getPopupContainer={() => document.body}
          >
            <Button
              type="text"
              aria-label="More actions"
              icon={<MoreOutlined />}
              size="small"
              onClick={(e) => e.stopPropagation()}
            />
          </Dropdown>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {contextHolder}

      <Card size="small" style={{ background: token.colorFillQuaternary }}>
        <Row gutter={16}>
          <Col span={6}>
            <Statistic
              title="Total Policies"
              value={policies.length}
              prefix={<ThunderboltOutlined />}
            />
          </Col>
          <Col span={6}>
            <Statistic
              title="Active"
              value={activePolicies}
              valueStyle={{ color: token.colorSuccess }}
              prefix={<CheckCircleOutlined />}
            />
          </Col>
          <Col span={6}>
            <Statistic title="Users Covered" value={totalAffected} prefix={<UserOutlined />} />
          </Col>
          <Col span={6}>
            <Statistic
              title="High Risk"
              value={highRiskPolicies}
              valueStyle={{
                color: highRiskPolicies > 0 ? token.colorErrorActive : token.colorTextTertiary,
              }}
            />
          </Col>
        </Row>
      </Card>

      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space>
          <Input
            placeholder="Search policies..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 250 }}
            allowClear
          />
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 130 }}
            options={[
              { value: 'all', label: 'All Status' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
              { value: 'draft', label: 'Draft' },
              { value: 'testing', label: 'Testing' },
            ]}
          />
          <Button
            aria-label="Refresh policies"
            icon={<ReloadOutlined />}
            onClick={() => refetch()}
            loading={isLoading}
          />
        </Space>
        {canEditPolicy && (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreatePolicy}>
            New Policy
          </Button>
        )}
      </Space>

      <Spin spinning={isLoading}>
        <Table
          dataSource={filteredPolicies}
          columns={columns}
          rowKey="id"
          size="small"
          pagination={false}
          virtual
          scroll={{ x: 900, y: 560 }}
          tableLayout="fixed"
          locale={{
            emptyText: isLoading ? ' ' : 'No policies yet. Click "New Policy" to create one.',
          }}
          onRow={(record) => ({
            onClick: () => onEditPolicy(record),
            style: { cursor: 'pointer', opacity: record.status === 'disabled' ? 0.6 : 1 },
          })}
        />
      </Spin>
    </Space>
  );
};
