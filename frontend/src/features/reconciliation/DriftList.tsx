/**
 * DriftList – filterable, sortable table of reconciliation drifts.
 * Severity/type tags, user column (onUserClick; the dashboard opens the identity page), actions, bulk operations.
 * View opens and closes a drift's details (its expanded row).
 */

import React, { useMemo, useState, useEffect, memo } from 'react';
import {
  Card,
  Table,
  Tag,
  Space,
  Avatar,
  Button,
  Select,
  Input,
  Typography,
  Skeleton,
  Tooltip,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  UserOutlined,
  ThunderboltOutlined,
  EyeOutlined,
  StopOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import type { IDrift, DriftType, DriftSeverity, DriftStatus } from '../../interfaces';
import { DRIFT_TYPE_LABELS } from '../../interfaces/reconciliation.interface';
import { relativeTime } from '../../utils/date-helpers';
import { EmptyState } from '../../components/common/EmptyState';
import { BulkActionBar } from '../../components/common/BulkActionBar';
import { MobileCardView } from '../../components/common/MobileCardView';

const { Text } = Typography;

// ── Helpers ─────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<DriftSeverity, string> = {
  critical: 'red',
  high: 'orange',
  medium: 'blue',
  low: 'default',
};

const SeverityTag = memo(({ severity }: { severity: DriftSeverity }) => (
  <Tag color={SEVERITY_COLORS[severity]}>{severity}</Tag>
));
SeverityTag.displayName = 'SeverityTag';

const TypeTag = memo(({ type }: { type: DriftType }) => (
  <Tag>{DRIFT_TYPE_LABELS[type] ?? type}</Tag>
));
TypeTag.displayName = 'TypeTag';

const STATUS_TAGS: Record<DriftStatus, { label: string; color: string }> = {
  open: { label: 'Open', color: 'processing' },
  quarantined: { label: 'Quarantined', color: 'warning' },
  corrected: { label: 'Corrected', color: 'success' },
  ignored: { label: 'Ignored', color: 'default' },
};

/** The API stores a drift without a status as open. */
const statusOf = (drift: IDrift): DriftStatus => drift.status ?? 'open';

/**
 * What the API takes (DriftService): Auto-Fix and Ignore on an open drift, and Ignore on a
 * quarantined orphan drift (single route). The bulk routes act on open drifts only.
 */
const isOpen = (drift: IDrift) => statusOf(drift) === 'open';
const canIgnore = (drift: IDrift) =>
  isOpen(drift) || (statusOf(drift) === 'quarantined' && drift.type === 'ORPHAN_ACCOUNT');

const CopyableValue = memo(({ value }: { value: string }) =>
  value ? <Text copyable>{value}</Text> : <span>—</span>,
);
CopyableValue.displayName = 'CopyableValue';

// ── Props ───────────────────────────────────────────────────────────────

export interface DriftListFilters {
  severity?: DriftSeverity | 'all';
  type?: DriftType | 'all';
  targetSystem?: string;
  search?: string;
}

export interface DriftListProps {
  drifts?: IDrift[];
  loading?: boolean;
  onUserClick?: (userId: string) => void;
  onAutoFix?: (driftIds: string[]) => void;
  onIgnore?: (driftIds: string[]) => void;
  /** When false, Auto-Fix and Ignore actions are hidden (viewer role) */
  canOperate?: boolean;
  emptyMessage?: string;
  /** Server-side pagination. When provided, filtering is handled by parent. */
  pagination?: {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number) => void;
  };
  /** Controlled filters when using server-side pagination */
  filters?: DriftListFilters;
  onFilterChange?: (filters: DriftListFilters) => void;
}

// ── Component ────────────────────────────────────────────────────────────

export const DriftList: React.FC<DriftListProps> = ({
  drifts = [],
  loading = false,
  onUserClick,
  onAutoFix,
  onIgnore,
  canOperate = true,
  emptyMessage = 'No drifts detected',
  pagination,
  filters,
  onFilterChange,
}) => {
  const { token } = theme.useToken();
  const [severityFilter, setSeverityFilter] = useState<DriftSeverity | 'all'>(
    filters?.severity ?? 'all',
  );
  const [typeFilter, setTypeFilter] = useState<DriftType | 'all'>(filters?.type ?? 'all');
  const [targetFilter, setTargetFilter] = useState<string>(filters?.targetSystem ?? 'all');
  const [search, setSearch] = useState(filters?.search ?? '');
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  // Rows whose details are open (View, or the row's expand icon)
  const [expandedRowKeys, setExpandedRowKeys] = useState<readonly React.Key[]>([]);
  const toggleDetails = (driftId: string) =>
    setExpandedRowKeys((keys) =>
      keys.includes(driftId) ? keys.filter((key) => key !== driftId) : [...keys, driftId],
    );

  useEffect(() => {
    if (filters?.search !== undefined) {
      const val = filters.search;
      queueMicrotask(() => setSearch(val));
    }
  }, [filters?.search]);

  const isServerSide = !!pagination && !!onFilterChange;
  const severity = isServerSide ? (filters?.severity ?? 'all') : severityFilter;
  const type = isServerSide ? (filters?.type ?? 'all') : typeFilter;
  const target = isServerSide ? (filters?.targetSystem ?? 'all') : targetFilter;
  const searchVal = search;

  const targetSystems = useMemo(() => {
    const set = new Set(drifts.map((d) => d.targetSystem));
    return Array.from(set).sort();
  }, [drifts]);

  const filteredDrifts = useMemo(() => {
    if (isServerSide) return drifts;
    return drifts.filter((d) => {
      if (severityFilter !== 'all' && d.severity !== severityFilter) return false;
      if (typeFilter !== 'all' && d.type !== typeFilter) return false;
      if (targetFilter !== 'all' && d.targetSystem !== targetFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!d.userDisplayName.toLowerCase().includes(q) && !d.userEmail.toLowerCase().includes(q))
          return false;
      }
      return true;
    });
  }, [drifts, severityFilter, typeFilter, targetFilter, search, isServerSide]);

  const handleFilterChange = (updates: Partial<DriftListFilters>) => {
    if (isServerSide && onFilterChange) {
      onFilterChange({
        severity: severity as DriftSeverity | 'all',
        type: type as DriftType | 'all',
        targetSystem: target,
        search: searchVal,
        ...updates,
      });
    } else {
      if (updates.severity !== undefined) setSeverityFilter(updates.severity);
      if (updates.type !== undefined) setTypeFilter(updates.type);
      if (updates.targetSystem !== undefined) setTargetFilter(updates.targetSystem);
      if (updates.search !== undefined) setSearch(updates.search);
    }
  };

  const handleBulkAutoFix = () => {
    const ids = selectedRowKeys.map(String).filter((id) => {
      const d = drifts.find((x) => x.id === id);
      return d?.autoCorrectEligible;
    });
    onAutoFix?.(ids);
    setSelectedRowKeys([]);
  };

  const handleBulkIgnore = () => {
    onIgnore?.(selectedRowKeys.map(String));
    setSelectedRowKeys([]);
  };

  const columns: ColumnsType<IDrift> = [
    {
      title: 'Severity',
      dataIndex: 'severity',
      key: 'severity',
      width: 100,
      sorter: (a, b) =>
        ['critical', 'high', 'medium', 'low'].indexOf(a.severity) -
        ['critical', 'high', 'medium', 'low'].indexOf(b.severity),
      render: (severity: DriftSeverity) => <SeverityTag severity={severity} />,
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 140,
      render: (type: DriftType) => <TypeTag type={type} />,
    },
    {
      title: 'User',
      key: 'user',
      width: 300,
      render: (_, record) => (
        <Space
          size="middle"
          style={{ cursor: onUserClick ? 'pointer' : undefined }}
          onClick={() => onUserClick?.(record.userId)}
        >
          <Avatar icon={<UserOutlined />} src={undefined}>
            {record.userDisplayName.slice(0, 2).toUpperCase()}
          </Avatar>
          <Space direction="vertical" size={0}>
            <Text strong>{record.userDisplayName}</Text>
            <Text type="secondary" className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {record.userEmail}
            </Text>
          </Space>
        </Space>
      ),
    },
    {
      title: 'Target System',
      dataIndex: 'targetSystem',
      key: 'targetSystem',
      width: 160,
      render: (t: string) => <Tag>{t}</Tag>,
    },
    {
      title: 'Field',
      dataIndex: 'field',
      key: 'field',
      width: 120,
      render: (v: string) => v ?? '—',
    },
    {
      title: 'Hub Value',
      dataIndex: 'hubValue',
      key: 'hubValue',
      width: 140,
      ellipsis: true,
      render: (v: string) => <CopyableValue value={v ?? ''} />,
    },
    {
      title: 'Target Value',
      dataIndex: 'targetValue',
      key: 'targetValue',
      width: 140,
      ellipsis: true,
      render: (v: string) => <CopyableValue value={v ?? ''} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, record) => {
        const tag = STATUS_TAGS[statusOf(record)] ?? { label: record.status, color: 'default' };
        return <Tag color={tag.color}>{tag.label}</Tag>;
      },
    },
    {
      title: 'Detected',
      dataIndex: 'detectedAt',
      key: 'detectedAt',
      width: 110,
      sorter: (a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
      defaultSortOrder: 'descend',
      render: (iso: string) => <Text type="secondary">{relativeTime(iso)}</Text>,
    },
    {
      title: 'Actions',
      key: 'actions',
      // Auto-Fix, Ignore and View on one line
      width: 290,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          {canOperate && record.autoCorrectEligible && isOpen(record) && (
            <Tooltip title="Auto-Fix this drift">
              <Button
                type="link"
                size="small"
                icon={<ThunderboltOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onAutoFix?.([record.id]);
                }}
              >
                Auto-Fix
              </Button>
            </Tooltip>
          )}
          {canOperate && canIgnore(record) && (
            <Tooltip title="Ignore this drift">
              <Button
                type="link"
                size="small"
                icon={<StopOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onIgnore?.([record.id]);
                }}
              >
                Ignore
              </Button>
            </Tooltip>
          )}
          <Tooltip title={expandedRowKeys.includes(record.id) ? 'Hide details' : 'View details'}>
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              aria-expanded={expandedRowKeys.includes(record.id)}
              onClick={(e) => {
                e.stopPropagation();
                toggleDetails(record.id);
              }}
            >
              View
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ];

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  return (
    <div style={{ padding: '0 24px 24px' }}>
      {/* Filter bar */}
      <Space wrap style={{ marginBottom: 16 }} size="middle">
        <Select
          value={severity}
          onChange={(v) => handleFilterChange({ severity: v as DriftSeverity | 'all' })}
          style={{ width: 120 }}
          options={[
            { value: 'all', label: 'All severities' },
            ...(['critical', 'high', 'medium', 'low'] as const).map((s) => ({
              value: s,
              label: s,
            })),
          ]}
        />
        <Select
          value={type}
          onChange={(v) => handleFilterChange({ type: v as DriftType | 'all' })}
          style={{ width: 180 }}
          options={[
            { value: 'all', label: 'All types' },
            ...Object.entries(DRIFT_TYPE_LABELS).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
        <Select
          value={target}
          onChange={(v) => handleFilterChange({ targetSystem: v })}
          style={{ width: 180 }}
          options={[
            { value: 'all', label: 'All systems' },
            ...targetSystems.map((t) => ({ value: t, label: t })),
          ]}
        />
        <Input.Search
          placeholder="Search by user name or email"
          allowClear
          value={searchVal}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!isServerSide) handleFilterChange({ search: e.target.value });
          }}
          onSearch={(v) => (isServerSide ? handleFilterChange({ search: v }) : undefined)}
          style={{ width: 260 }}
        />
      </Space>

      {/* Floating bulk action bar */}
      {canOperate && (
        <BulkActionBar
          selectedCount={selectedRowKeys.length}
          actions={[
            { label: 'Auto-Fix', onClick: handleBulkAutoFix, icon: <ThunderboltOutlined /> },
            { label: 'Ignore', onClick: handleBulkIgnore, icon: <StopOutlined />, danger: true },
          ]}
          onClear={() => setSelectedRowKeys([])}
        />
      )}

      <MobileCardView<IDrift>
        dataSource={filteredDrifts}
        renderCard={(drift) => (
          <Card
            size="small"
            className="card-hover-lift"
            style={{ cursor: onUserClick ? 'pointer' : undefined }}
            onClick={() => onUserClick?.(drift.userId)}
          >
            <Space direction="vertical" style={{ width: '100%' }} size={4}>
              <Space>
                <SeverityTag severity={drift.severity} />
                <TypeTag type={drift.type} />
                <Tag>{drift.targetSystem}</Tag>
              </Space>
              <Space>
                <Avatar size="small" icon={<UserOutlined />}>
                  {drift.userDisplayName.slice(0, 2).toUpperCase()}
                </Avatar>
                <div>
                  <Text strong style={{ fontSize: 13 }}>
                    {drift.userDisplayName}
                  </Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {drift.userEmail}
                  </Text>
                </div>
              </Space>
              {drift.field && (
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {drift.field}:
                  </Text>
                  <Text style={{ fontSize: 12, color: token.colorSuccess }}>
                    {drift.hubValue ?? '—'}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    →
                  </Text>
                  <Text style={{ fontSize: 12, color: token.colorError }}>
                    {drift.targetValue ?? '—'}
                  </Text>
                </Space>
              )}
              <Space size="small" style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {relativeTime(drift.detectedAt)}
                </Text>
                {canOperate && drift.autoCorrectEligible && isOpen(drift) && (
                  <Button
                    type="link"
                    size="small"
                    icon={<ThunderboltOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAutoFix?.([drift.id]);
                    }}
                  >
                    Fix
                  </Button>
                )}
              </Space>
            </Space>
          </Card>
        )}
      >
        <Table<IDrift>
          rowKey="id"
          columns={columns}
          dataSource={filteredDrifts}
          scroll={{ x: 1200 }}
          rowSelection={
            canOperate
              ? {
                  selectedRowKeys,
                  onChange: setSelectedRowKeys,
                  getCheckboxProps: (record) => ({ disabled: !isOpen(record) }),
                }
              : undefined
          }
          pagination={
            pagination
              ? {
                  current: pagination.current,
                  pageSize: pagination.pageSize,
                  total: pagination.total,
                  onChange: pagination.onChange,
                  showSizeChanger: false,
                  showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
                }
              : false
          }
          expandable={{
            expandedRowKeys,
            onExpandedRowsChange: setExpandedRowKeys,
            expandedRowRender: (record) => (
              <div style={{ padding: '8px 24px', background: token.colorFillQuaternary }}>
                <Text strong>Full drift details</Text>
                <pre style={{ marginTop: 8, fontSize: 12, overflow: 'auto' }}>
                  {JSON.stringify(
                    {
                      ...record,
                      hubValue: record.hubValue,
                      targetValue: record.targetValue,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
            ),
          }}
          locale={{
            emptyText: (
              <EmptyState
                icon={<CheckCircleOutlined style={{ fontSize: 48, color: token.colorSuccess }} />}
                title="All in sync"
                description={emptyMessage}
              />
            ),
          }}
        />
      </MobileCardView>
    </div>
  );
};
