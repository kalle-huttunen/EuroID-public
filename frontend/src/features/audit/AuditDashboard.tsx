/**
 * Audit & Compliance – searchable audit log with filters, expandable rows, and CSV export.
 * Fetches from GET /api/v1/audit and GET /api/v1/audit/stats via useAuditEvents / useAuditStats.
 */

import React, { useState, useMemo, useEffect, memo } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Typography,
  Input,
  Select,
  DatePicker,
  Tag,
  Tooltip,
  Skeleton,
  Result,
  message,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ExportOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import relativeTime from 'dayjs/plugin/relativeTime';
import type {
  IAuditEvent,
  IAuditFilter,
  AuditAction,
  AuditSeverity,
} from '../../interfaces/audit.interface';
import { fetchAuditEventsForExport, useAuditEvents, useAuditStats } from '@api/audit-api';
import { AUDIT_EXPORT_MAX_EVENTS } from '@config/pagination';
import { eventsToCSV, wholeDays, type DateRange } from './audit-export';
import { targetSystemOptions } from './audit-target-systems';
import { useAvailableConnectors } from '@api/connectors-api';
import { POLL_INTERVALS } from '@config/polling';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { LiveBadge } from '@shared/LiveBadge';
import { EmptyState } from '../../components/common/EmptyState';
import { KpiBand } from '@shared/KpiBand';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

dayjs.extend(relativeTime);

const { Text } = Typography;
const PAGE_SIZE = 50;

const ACTION_LABELS: Record<AuditAction, string> = {
  USER_CREATED: 'User created',
  USER_UPDATED: 'User updated',
  USER_DELETED: 'User deleted',
  POLICY_CREATED: 'Policy created',
  POLICY_UPDATED: 'Policy updated',
  POLICY_DELETED: 'Policy deleted',
  POLICY_TOGGLED: 'Policy toggled',
  PROVISIONING_EXECUTED: 'Provisioning OK',
  PROVISIONING_FAILED: 'Provisioning failed',
  RECONCILIATION_RUN: 'Reconciliation run',
  DRIFT_CORRECTED: 'Drift corrected',
  BULK_OPERATION_STARTED: 'Bulk started',
  BULK_OPERATION_COMPLETED: 'Bulk completed',
  CONNECTOR_INSTALLED: 'Connector installed',
  CONNECTOR_REMOVED: 'Connector removed',
  CONFIG_CHANGED: 'Config changed',
  APPROVAL_GRANTED: 'Approval granted',
  APPROVAL_DENIED: 'Approval denied',
};

const ActionCell = memo(({ action }: { action: AuditAction }) => (
  <Tag color="blue">{ACTION_LABELS[action] ?? action}</Tag>
));
ActionCell.displayName = 'ActionCell';

const SeverityCell = memo(({ severity }: { severity: AuditSeverity }) => {
  const { token } = theme.useToken();
  const severityColors: Record<AuditSeverity, string> = {
    info: token.colorPrimary,
    warning: token.colorWarning,
    error: token.colorError,
    critical: token.colorErrorActive,
  };
  return (
    <Space size="small">
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: severityColors[severity],
          display: 'inline-block',
        }}
      />
      <Text style={{ textTransform: 'capitalize' }}>{severity}</Text>
    </Space>
  );
});
SeverityCell.displayName = 'SeverityCell';

/**
 * The time window a link names (`dateFrom`, `dateTo`, ISO), or null. The audit integrity page links
 * a broken event's moment this way.
 */
function linkedRange(params: URLSearchParams): DateRange | null {
  const time = (value: string | null) => (value && dayjs(value).isValid() ? dayjs(value) : null);
  const range: DateRange = [time(params.get('dateFrom')), time(params.get('dateTo'))];
  return range[0] || range[1] ? range : null;
}

function formatRelative(timestamp: string): string {
  return dayjs(timestamp).fromNow();
}

function downloadCSV(events: IAuditEvent[]) {
  const csv = eventsToCSV(events);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${dayjs().format('YYYY-MM-DD')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export const AuditDashboard: React.FC = () => {
  const { token } = theme.useToken();
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [search, setSearch] = useState('');
  const [actions, setActions] = useState<AuditAction[]>([]);
  const [severities, setSeverities] = useState<AuditSeverity[]>([]);
  const [targetSystem, setTargetSystem] = useState<string | undefined>(undefined);
  const [searchParams] = useSearchParams();
  const [linked] = useState(() => linkedRange(searchParams));
  const [dateRange, setDateRange] = useState<DateRange>(linked ?? [null, null]);
  // A linked window is shown to the second until the range is changed here.
  const [showLinkedTime, setShowLinkedTime] = useState(!!linked);
  const [currentPage, setCurrentPage] = useState(1);

  const filter: IAuditFilter & { page?: number; limit?: number } = useMemo(() => {
    // A linked window keeps its exact times; a range picked here covers whole days
    const [dateFrom, dateTo] = showLinkedTime
      ? [dateRange[0]?.toISOString(), dateRange[1]?.toISOString()]
      : wholeDays(dateRange);
    return {
      search: search.trim() || undefined,
      action: actions.length ? actions : undefined,
      severity: severities.length ? severities : undefined,
      targetSystem: targetSystem || undefined,
      dateFrom,
      dateTo,
      page: currentPage,
      limit: PAGE_SIZE,
    };
  }, [search, actions, severities, targetSystem, dateRange, showLinkedTime, currentPage]);
  const [exporting, setExporting] = useState(false);

  const refetchOptions = {
    refetchInterval: autoRefresh ? POLL_INTERVALS.AUDIT_EVENTS_MS : false,
  } as const;
  const {
    data: eventsData,
    isLoading,
    isError,
    error,
    refetch,
  } = useAuditEvents(filter, refetchOptions);
  const { data: statsData, refetch: refetchStats } = useAuditStats(refetchOptions);

  const events = eventsData?.data ?? [];
  const totalEvents = eventsData?.total ?? 0;
  const stats = statsData ?? { total: 0, critical: 0, warnings: 0, todayCount: 0 };

  useEffect(() => {
    if (isError && error) {
      message.error(`Failed to load audit log: ${apiErrorMessage(error, 'Unknown error')}`);
    }
  }, [isError, error]);

  // Every registered connector, not only the systems the current page happens to show.
  const { data: connectors } = useAvailableConnectors();
  const targetSystemChoices = useMemo(
    () =>
      targetSystemOptions(
        connectors ?? [],
        events.map((e) => e.targetSystem),
        targetSystem,
      ),
    [connectors, events, targetSystem],
  );

  const handleRefresh = () => {
    refetch();
    refetchStats();
    message.success('Audit log refreshed');
  };

  /** Every event the filters match (not only this page), up to AUDIT_EXPORT_MAX_EVENTS. */
  const handleExportCSV = async () => {
    setExporting(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { page: _page, limit: _limit, ...filters } = filter;
      const { events: all, total } = await fetchAuditEventsForExport(
        filters,
        AUDIT_EXPORT_MAX_EVENTS,
      );
      downloadCSV(all);
      if (all.length < total) {
        message.warning(
          `Exported the newest ${all.length} of ${total} events: narrow the filters to export the rest`,
        );
      } else {
        message.success(`Exported ${all.length} events to CSV`);
      }
    } catch (err) {
      message.error(`Export failed: ${apiErrorMessage(err, 'the request failed')}`);
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<IAuditEvent> = [
    {
      title: 'Time',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 120,
      render: (_, record) => (
        <Tooltip title={dayjs(record.timestamp).format('YYYY-MM-DD HH:mm:ss Z')}>
          <span className="mono" style={{ whiteSpace: 'nowrap' }}>
            {formatRelative(record.timestamp)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: 'Action',
      dataIndex: 'action',
      key: 'action',
      width: 160,
      render: (action: AuditAction) => <ActionCell action={action} />,
    },
    {
      title: 'Severity',
      dataIndex: 'severity',
      key: 'severity',
      width: 100,
      render: (severity: AuditSeverity) => <SeverityCell severity={severity} />,
    },
    {
      title: 'Actor',
      dataIndex: 'actor',
      key: 'actor',
      width: 160,
      ellipsis: true,
      render: (actor: string) => (
        <Tooltip title={actor}>
          <span>{actor}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Resource',
      dataIndex: 'resourceName',
      key: 'resourceName',
      ellipsis: true,
      render: (name: string, record) => (
        <Tooltip
          title={record.resourceId ? <span className="mono">{record.resourceId}</span> : undefined}
        >
          <span>{name}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Target system',
      dataIndex: 'targetSystem',
      key: 'targetSystem',
      width: 140,
      render: (sys: string | undefined) =>
        sys ? <Tag>{sys}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (desc: string) => (
        <Tooltip title={desc}>
          <span>{desc}</span>
        </Tooltip>
      ),
    },
  ];

  const expandableRow = {
    rowExpandable: (record: IAuditEvent) =>
      !!(record.payload && Object.keys(record.payload).length > 0),
    expandedRowRender: (record: IAuditEvent) => {
      const payload = record.payload;
      if (!payload || Object.keys(payload).length === 0) {
        return <Text type="secondary">No payload</Text>;
      }
      return (
        <pre
          style={{
            margin: 0,
            fontSize: 12,
            background: token.colorFillQuaternary,
            padding: 12,
            borderRadius: 4,
          }}
        >
          {JSON.stringify(payload, null, 2)}
        </pre>
      );
    },
  };

  return (
    <PageContainer>
      <PageHeader
        title="Audit & compliance"
        titleExtra={<LiveBadge />}
        subtitle="Every identity, access and configuration change, newest first"
        actions={
          <>
            <Button
              icon={<ExportOutlined />}
              onClick={() => void handleExportCSV()}
              loading={exporting}
              disabled={events.length === 0}
            >
              Export CSV
            </Button>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={isLoading}>
              Refresh
            </Button>
            <Button
              type={autoRefresh ? 'primary' : 'default'}
              icon={<SyncOutlined spin={autoRefresh} />}
              onClick={() => setAutoRefresh((a) => !a)}
              aria-pressed={autoRefresh}
            >
              {autoRefresh ? 'Auto-refresh on' : 'Auto-refresh'}
            </Button>
          </>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <KpiBand
          items={[
            { key: 'total', label: 'Total events', value: stats.total },
            {
              key: 'critical',
              label: 'Critical',
              value: stats.critical,
              tone: stats.critical > 0 ? 'error' : 'default',
            },
            {
              key: 'warnings',
              label: 'Warnings',
              value: stats.warnings,
              tone: stats.warnings > 0 ? 'warning' : 'default',
            },
            { key: 'today', label: 'Today', value: stats.todayCount },
          ]}
        />
      </div>

      {/* Filters */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap size="middle" style={{ width: '100%' }}>
          <Input.Search
            placeholder="Search description, resource, actor..."
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 260 }}
          />
          <Select
            placeholder="Action"
            mode="multiple"
            allowClear
            value={actions.length ? actions : undefined}
            onChange={setActions}
            options={Object.entries(ACTION_LABELS).map(([value, label]) => ({
              value: value as AuditAction,
              label,
            }))}
            style={{ minWidth: 180 }}
          />
          <Select
            placeholder="Severity"
            mode="multiple"
            allowClear
            value={severities.length ? severities : undefined}
            onChange={setSeverities}
            options={[
              { value: 'info', label: 'Info' },
              { value: 'warning', label: 'Warning' },
              { value: 'error', label: 'Error' },
              { value: 'critical', label: 'Critical' },
            ]}
            style={{ minWidth: 140 }}
          />
          <Select
            placeholder="Target system"
            allowClear
            value={targetSystem || undefined}
            onChange={setTargetSystem}
            options={targetSystemChoices}
            style={{ minWidth: 160 }}
          />
          <DatePicker.RangePicker
            value={dateRange}
            format={showLinkedTime ? 'YYYY-MM-DD HH:mm:ss' : undefined}
            onChange={(dates) => {
              setShowLinkedTime(false);
              setDateRange((dates ?? [null, null]) as DateRange);
            }}
          />
        </Space>
      </Card>

      {/* Table */}
      <Card size="small" role="region" aria-label="Audit log">
        {isError ? (
          <Result
            status="warning"
            title="Failed to load data"
            subTitle={apiErrorMessage(error, 'An unexpected error occurred')}
            extra={<Button onClick={() => refetch()}>Retry</Button>}
          />
        ) : isLoading ? (
          <Skeleton active paragraph={{ rows: 8 }} aria-busy aria-label="Loading data" />
        ) : (
          <Table<IAuditEvent>
            rowKey="id"
            columns={columns}
            dataSource={events}
            expandable={expandableRow}
            scroll={{ x: 'max-content' }}
            pagination={{
              current: currentPage,
              pageSize: PAGE_SIZE,
              total: totalEvents,
              showSizeChanger: false,
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
              onChange: setCurrentPage,
            }}
            locale={{
              emptyText: (
                <EmptyState
                  title="No audit events match your filters"
                  description="Try adjusting your search criteria or date range"
                />
              ),
            }}
          />
        )}
      </Card>
    </PageContainer>
  );
};
