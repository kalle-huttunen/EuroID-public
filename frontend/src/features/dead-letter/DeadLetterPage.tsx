/**
 * Dead-letter queue: events, workflow steps and connector calls that failed for good, newest
 * first. Operators filter, read and dismiss entries; a super-admin can retry or replay an entry
 * that carries a domain event (DeadLetterDetailModal). Route and nav entry need operator, like
 * GET /dead-letter.
 */
import React, { useState } from 'react';
import {
  Button,
  Card,
  Input,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  DEAD_LETTER_PAGE_SIZE,
  deadLetterKeys,
  useDeadLetterStats,
  useDeadLetters,
} from '@api/dead-letter-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { KpiBand } from '@shared/KpiBand';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import type {
  DeadLetterStatus,
  DeadLetterType,
  IDeadLetterEntry,
  IDeadLetterFilter,
} from '../../interfaces';
import { DeadLetterDetailModal } from './DeadLetterDetailModal';
import { STATUSES, STATUS_LABEL, STATUS_TAG, TYPES, TYPE_LABEL } from './dead-letter-labels';

const { Text } = Typography;

/** Below this width (phones) the table scrolls sideways instead of squeezing every column. */
const DEAD_LETTER_TABLE_MIN_WIDTH = 900;

export const DeadLetterPage: React.FC = () => {
  const qc = useQueryClient();
  // A link can name a source prefix (the webhooks page links a failed delivery's entries).
  const [searchParams] = useSearchParams();
  const linkedSource = searchParams.get('source')?.trim() || undefined;
  const [filter, setFilter] = useState<IDeadLetterFilter>(() =>
    linkedSource ? { source: linkedSource } : {},
  );
  const [sourceInput, setSourceInput] = useState(linkedSource ?? '');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<IDeadLetterEntry | null>(null);
  const list = useDeadLetters(filter, page);
  const stats = useDeadLetterStats();

  const applyFilter = (next: IDeadLetterFilter) => {
    setFilter(next);
    setPage(0);
  };
  const applySource = (source: string) => {
    setSourceInput(source);
    applyFilter({ ...filter, source: source.trim() || undefined });
  };
  const count = (status: DeadLetterStatus) => stats.data?.[status] ?? 0;
  const statusKpi = (status: DeadLetterStatus, tone?: 'warning' | 'error') => ({
    key: status,
    label: STATUS_LABEL[status],
    value: stats.isError ? null : count(status),
    tone: tone && count(status) > 0 ? tone : ('default' as const),
    onClick: () => applyFilter({ ...filter, status }),
    actionLabel: `Show ${STATUS_LABEL[status].toLowerCase()} entries`,
  });

  // Fixed column widths, Source and Error cut with an ellipsis (full text on hover): the table
  // fits the page at desktop widths. Retries are in the entry's details.
  const columns: ColumnsType<IDeadLetterEntry> = [
    {
      title: 'Captured',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 150,
      render: (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 150,
      render: (type: DeadLetterType) => <Tag>{TYPE_LABEL[type] ?? type}</Tag>,
    },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      width: 260,
      render: (source: string) => (
        <Tooltip title={`Show entries from ${source}`}>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 'auto', maxWidth: '100%' }}
            onClick={() => applySource(source)}
          >
            <Text code ellipsis>
              {source}
            </Text>
          </Button>
        </Tooltip>
      ),
    },
    {
      title: 'Error',
      key: 'error',
      ellipsis: { showTitle: false },
      render: (_: unknown, entry) => (
        <Tooltip title={entry.error?.message}>
          <span>{entry.error?.message}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 150,
      render: (status: DeadLetterStatus) => (
        <Tag color={STATUS_TAG[status]}>{STATUS_LABEL[status] ?? status}</Tag>
      ),
    },
    {
      title: '',
      key: 'open',
      width: 96,
      render: (_: unknown, entry) => (
        <Button
          size="small"
          onClick={() => setSelected(entry)}
          aria-label={`Open entry ${entry.source} captured ${dayjs(entry.createdAt).format('YYYY-MM-DD HH:mm')}`}
        >
          Details
        </Button>
      ),
    },
  ];

  const filtered = !!(filter.status || filter.type || filter.source);
  const items = list.data?.items ?? [];

  let body: React.ReactNode;
  if (list.isLoading) {
    body = <Skeleton active paragraph={{ rows: 6 }} />;
  } else if (list.isError) {
    body = (
      <ErrorState
        title="Could not load the dead-letter queue"
        error={list.error}
        onRetry={() => list.refetch()}
      />
    );
  } else if (!items.length) {
    body = (
      <EmptyState
        title={filtered ? 'No entries match these filters' : 'The dead-letter queue is empty'}
        description={
          filtered
            ? undefined
            : 'Events, workflow steps and connector calls that fail for good appear here.'
        }
        action={
          filtered
            ? {
                label: 'Clear filters',
                type: 'default',
                onClick: () => {
                  setSourceInput('');
                  applyFilter({});
                },
              }
            : undefined
        }
      />
    );
  } else {
    body = (
      <>
        <Table<IDeadLetterEntry>
          size="small"
          rowKey="_id"
          columns={columns}
          dataSource={items}
          pagination={false}
          tableLayout="fixed"
          scroll={{ x: DEAD_LETTER_TABLE_MIN_WIDTH }}
        />
        <Space style={{ marginTop: 12, width: '100%', justifyContent: 'flex-end' }}>
          <Text type="secondary">Page {page + 1}</Text>
          <Button
            icon={<LeftOutlined />}
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Newer
          </Button>
          <Button
            icon={<RightOutlined />}
            iconPosition="end"
            disabled={!list.data?.hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Older
          </Button>
        </Space>
      </>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Dead-letter queue"
        subtitle={`Events, workflow steps and connector calls that failed for good, ${DEAD_LETTER_PAGE_SIZE} per page, newest first. Kept for 90 days.`}
        actions={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => qc.invalidateQueries({ queryKey: deadLetterKeys.all })}
          >
            Refresh
          </Button>
        }
      />
      <div style={{ marginBottom: 16 }}>
        <KpiBand
          loading={stats.isLoading}
          items={[
            statusKpi('pending', 'warning'),
            statusKpi('failed_permanently', 'error'),
            statusKpi('replayed'),
            statusKpi('dismissed'),
          ]}
        />
      </div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap size="middle">
          <Select<DeadLetterStatus>
            aria-label="Status"
            placeholder="Any status"
            allowClear
            value={filter.status}
            onChange={(status) => applyFilter({ ...filter, status })}
            options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
            style={{ minWidth: 180 }}
          />
          <Select<DeadLetterType>
            aria-label="Type"
            placeholder="Any type"
            allowClear
            value={filter.type}
            onChange={(type) => applyFilter({ ...filter, type })}
            options={TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
            style={{ minWidth: 200 }}
          />
          <Input.Search
            aria-label="Source starts with"
            placeholder="Source starts with, e.g. webhook:"
            allowClear
            value={sourceInput}
            onChange={(e) => setSourceInput(e.target.value)}
            onSearch={applySource}
            maxLength={200}
            style={{ width: 280 }}
          />
        </Space>
      </Card>
      <Card size="small" role="region" aria-label="Dead-letter entries" aria-busy={list.isFetching}>
        {body}
      </Card>
      <DeadLetterDetailModal row={selected} onClose={() => setSelected(null)} />
    </PageContainer>
  );
};
