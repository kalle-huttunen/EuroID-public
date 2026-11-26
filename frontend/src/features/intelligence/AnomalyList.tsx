/**
 * AnomalyList — Anomalies card with filters and table. View opens AnomalyDetailModal;
 * acknowledge and dismiss need operator, like the API.
 */

import React from 'react';
import { Card, Table, Skeleton, Select, Space, Button, Tag } from 'antd';
import { EmptyState } from '../../components/common/EmptyState';
import type { ColumnsType } from 'antd/es/table';
import { EyeOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  type Anomaly,
  type AnomalyType,
  type AnomalySeverity,
  type AnomalyStatus,
} from '@api/intelligence-api';
import type { IStandardUser } from '../../interfaces';
import type { AcknowledgeMutationSlice } from './hooks/useAnomalyData';
import { getDisplayName } from './hooks/useRiskScoreEnrichment';
import { RISK_DASHBOARD_PAGE_SIZE } from '@config/pagination';
import { usePermission } from '../../auth/usePermission';
import { ANOMALY_TYPE_LABELS, SEVERITY_COLORS, STATUS_COLORS } from './anomaly-labels';

dayjs.extend(relativeTime);

/** Below this the table scrolls sideways in its card instead of squeezing the columns. */
const ANOMALY_TABLE_MIN_WIDTH = 1000;

interface AnomalyListProps {
  anomalies: Anomaly[];
  totalAnomalies: number;
  anomalyFilters: { type?: AnomalyType; severity?: AnomalySeverity; status?: AnomalyStatus };
  setAnomalyFilters: React.Dispatch<
    React.SetStateAction<{ type?: AnomalyType; severity?: AnomalySeverity; status?: AnomalyStatus }>
  >;
  anomalyPage: number;
  setAnomalyPage: (page: number) => void;
  identityMap: Map<string, IStandardUser>;
  anomaliesLoading: boolean;
  acknowledgeMutation: AcknowledgeMutationSlice;
  handleDismiss: (id: string) => void;
  /** Receives the anomaly's `anomalyId`, the id the `/anomalies/:id` routes take. */
  setSelectedAnomalyId: (id: string | null) => void;
}

export const AnomalyList: React.FC<AnomalyListProps> = ({
  anomalies,
  totalAnomalies,
  anomalyFilters,
  setAnomalyFilters,
  anomalyPage,
  setAnomalyPage,
  identityMap,
  anomaliesLoading,
  acknowledgeMutation,
  handleDismiss,
  setSelectedAnomalyId,
}) => {
  const isOperator = usePermission('operator');
  // A changed filter starts at page 1: the page it was chosen on may not exist in the new result.
  const filterBy = (change: Partial<AnomalyListProps['anomalyFilters']>) => {
    setAnomalyFilters((f) => ({ ...f, ...change }));
    setAnomalyPage(1);
  };
  const anomalyColumns: ColumnsType<Anomaly> = [
    {
      title: 'Identity',
      dataIndex: 'identityId',
      key: 'identityId',
      render: (id: string) => {
        const u = identityMap.get(id);
        return getDisplayName(u) || u?.email || id;
      },
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 160,
      render: (t: AnomalyType) => <Tag color="blue">{ANOMALY_TYPE_LABELS[t] ?? t}</Tag>,
    },
    {
      title: 'Severity',
      dataIndex: 'severity',
      key: 'severity',
      width: 100,
      render: (s: AnomalySeverity) => <Tag color={SEVERITY_COLORS[s]}>{s}</Tag>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: 'Detected At',
      dataIndex: 'detectedAt',
      key: 'detectedAt',
      width: 120,
      render: (d: string) => dayjs(d).fromNow(),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s: AnomalyStatus) => <Tag color={STATUS_COLORS[s]}>{s}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      // View, Acknowledge and Dismiss on one line
      width: 320,
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => setSelectedAnomalyId(record.anomalyId)}
          >
            View
          </Button>
          {isOperator && record.status === 'open' && (
            <>
              <Button
                type="link"
                size="small"
                icon={<CheckOutlined />}
                loading={acknowledgeMutation.isPending}
                onClick={() => acknowledgeMutation.mutate(record.anomalyId)}
              >
                Acknowledge
              </Button>
              <Button
                type="link"
                size="small"
                danger
                icon={<CloseOutlined />}
                onClick={() => handleDismiss(record.anomalyId)}
              >
                Dismiss
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card title="Anomalies">
      {/* The filters sit below the title: the card head has no room for them at 400 px. */}
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          placeholder="Type"
          allowClear
          style={{ width: 140 }}
          value={anomalyFilters.type}
          onChange={(v) => filterBy({ type: v })}
        >
          {Object.entries(ANOMALY_TYPE_LABELS).map(([k, v]) => (
            <Select.Option key={k} value={k}>
              {v}
            </Select.Option>
          ))}
        </Select>
        <Select
          placeholder="Severity"
          allowClear
          style={{ width: 100 }}
          value={anomalyFilters.severity}
          onChange={(v) => filterBy({ severity: v })}
        >
          <Select.Option value="low">Low</Select.Option>
          <Select.Option value="medium">Medium</Select.Option>
          <Select.Option value="high">High</Select.Option>
          <Select.Option value="critical">Critical</Select.Option>
        </Select>
        <Select
          placeholder="Status"
          allowClear
          style={{ width: 110 }}
          value={anomalyFilters.status}
          onChange={(v) => filterBy({ status: v })}
        >
          <Select.Option value="open">Open</Select.Option>
          <Select.Option value="acknowledged">Acknowledged</Select.Option>
          <Select.Option value="dismissed">Dismissed</Select.Option>
          <Select.Option value="resolved">Resolved</Select.Option>
        </Select>
      </Space>
      {anomaliesLoading ? (
        <Skeleton active />
      ) : anomalies.length === 0 ? (
        <EmptyState title="No anomalies detected" description="Run an analysis to get started." />
      ) : (
        <Table
          columns={anomalyColumns}
          dataSource={anomalies}
          rowKey="anomalyId"
          scroll={{ x: ANOMALY_TABLE_MIN_WIDTH }}
          pagination={{
            current: anomalyPage,
            pageSize: RISK_DASHBOARD_PAGE_SIZE,
            total: totalAnomalies,
            onChange: setAnomalyPage,
          }}
          size="small"
        />
      )}
    </Card>
  );
};
