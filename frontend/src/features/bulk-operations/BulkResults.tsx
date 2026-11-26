/**
 * Final results view for bulk provisioning. Shows summary stats and downloadable CSV export.
 */
import React, { useEffect, useState } from 'react';
import { Card, Table, Button, Space, Statistic, Row, Col, Alert, Spin, theme } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  DownloadOutlined,
  ReloadOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import type { IBulkResult, IBulkResultItem } from '../../interfaces/bulk-operation.interface';
import { axiosInstance } from '@api/data';
import { BULK_PROVISIONING_API } from '@config/api-routes';
import { PAGE_SIZES } from '@config/pagination';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { resultsToCsv } from './bulk-results-csv';

/**
 * A row's status. The workflow keeps `success` true on an operation a fail-fast or cancelled run
 * rolled back and sets `rolledBack`; such a row is no longer in place, so it is not a success.
 */
function rowStatus(r: Record<string, unknown>): IBulkResultItem['status'] {
  if (r.success === true) return r.rolledBack === true ? 'rolled-back' : 'success';
  return r.success === false ? 'failed' : 'skipped';
}

const STATUS_LABELS: Record<IBulkResultItem['status'], string> = {
  success: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
  'rolled-back': 'Rolled back',
};

function exportResultsToCsv(results: IBulkResultItem[]): void {
  const csv = resultsToCsv(results);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bulk-results-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface BulkResultsProps {
  workflowId: string | null;
  onStartNew: () => void;
}

export const BulkResults: React.FC<BulkResultsProps> = ({ workflowId, onStartNew }) => {
  const { token } = theme.useToken();
  const [result, setResult] = useState<IBulkResult | null>(null);
  const [loading, setLoading] = useState(!!workflowId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: json } = await axiosInstance.get(
          `${BULK_PROVISIONING_API}/results/${encodeURIComponent(workflowId)}`,
        );
        const data = json.results ?? json;
        if (cancelled) return;
        const summary = data.summary ?? {};
        setResult({
          batchId: data.batchId ?? workflowId,
          status: data.status ?? 'UNKNOWN',
          summary: {
            total: summary.total ?? 0,
            succeeded: summary.successful ?? summary.succeeded ?? 0,
            successful: summary.successful ?? summary.succeeded ?? 0,
            failed: summary.failed ?? 0,
            skipped: summary.skipped ?? 0,
            rolledBack: summary.rolledBack,
          },
          results: (data.results ?? []).map((r: Record<string, unknown>) => ({
            operationId: String(r.operationId ?? ''),
            status: rowStatus(r),
            success: r.success as boolean | undefined,
            error: r.error as string | undefined,
            rollbackReason: r.rollbackReason as string | undefined,
            userId: r.userId as string | undefined,
            email: r.email as string | undefined,
            type: r.type as string | undefined,
          })),
        });
      } catch (e) {
        if (!cancelled) setError(apiErrorMessage(e, 'Load failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  if (!workflowId) {
    return (
      <Alert
        message="No results yet"
        description="Complete a bulk run to see results here, or start a new batch."
        type="info"
        action={
          <Button icon={<ReloadOutlined />} onClick={onStartNew}>
            Start new batch
          </Button>
        }
      />
    );
  }

  if (loading)
    return (
      <Spin size="large" tip="Loading results…">
        <div style={{ minHeight: 200 }} />
      </Spin>
    );
  if (error) return <Alert message={error} type="error" showIcon />;
  if (!result) return null;

  const s = result.summary;
  const succeeded = s.succeeded ?? s.successful ?? 0;

  const columns = [
    { title: 'Operation ID', dataIndex: 'operationId', key: 'operationId', ellipsis: true },
    {
      title: 'User / Email',
      key: 'email',
      render: (_: unknown, r: IBulkResultItem) => r.email ?? r.userId ?? '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: IBulkResultItem['status']) => (
        <Space size={4}>
          {status === 'success' ? (
            <CheckCircleOutlined style={{ color: token.colorSuccess }} />
          ) : status === 'failed' ? (
            <CloseCircleOutlined style={{ color: token.colorError }} />
          ) : status === 'rolled-back' ? (
            <UndoOutlined style={{ color: token.colorWarning }} />
          ) : (
            <MinusCircleOutlined style={{ color: token.colorWarning }} />
          )}
          {STATUS_LABELS[status]}
        </Space>
      ),
    },
    {
      title: 'Error',
      key: 'error',
      ellipsis: true,
      // A rolled-back row has no error; its rollback reason says what was undone.
      render: (_: unknown, r: IBulkResultItem) => r.error ?? r.rollbackReason ?? '',
    },
  ];

  const rolledBack = s.rolledBack ?? 0;
  const statCol = rolledBack > 0 ? 6 : 8;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {result.status === 'CANCELLED' && (
        <Alert
          type="warning"
          showIcon
          message="The batch was cancelled"
          description={`${rolledBack} ${rolledBack === 1 ? 'operation' : 'operations'} that had run ${rolledBack === 1 ? 'was' : 'were'} rolled back; the remaining operations did not run. A DELETE cannot be rolled back.`}
        />
      )}
      {result.status !== 'CANCELLED' && rolledBack > 0 && (
        <Alert
          type="warning"
          showIcon
          message="The batch was rolled back after a failure"
          description={`An operation failed and continue on error was off, so ${rolledBack} ${rolledBack === 1 ? 'operation' : 'operations'} that had succeeded ${rolledBack === 1 ? 'was' : 'were'} rolled back. A DELETE cannot be rolled back.`}
        />
      )}
      <Row gutter={16}>
        <Col xs={24} sm={statCol}>
          <Card>
            <Statistic
              title="Succeeded"
              value={succeeded}
              prefix={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={statCol}>
          <Card>
            <Statistic
              title="Failed"
              value={s.failed}
              prefix={<CloseCircleOutlined style={{ color: token.colorError }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={statCol}>
          <Card>
            <Statistic
              title="Skipped"
              value={s.skipped}
              prefix={<MinusCircleOutlined style={{ color: token.colorWarning }} />}
            />
          </Card>
        </Col>
        {rolledBack > 0 && (
          <Col xs={24} sm={statCol}>
            <Card>
              <Statistic
                title="Rolled back"
                value={rolledBack}
                prefix={<UndoOutlined style={{ color: token.colorWarning }} />}
              />
            </Card>
          </Col>
        )}
      </Row>

      <div>
        <Button
          icon={<DownloadOutlined />}
          onClick={() => exportResultsToCsv(result.results)}
          style={{ marginRight: 8 }}
        >
          Export to CSV
        </Button>
        <Button type="primary" icon={<ReloadOutlined />} onClick={onStartNew}>
          Start new batch
        </Button>
      </div>

      <Table
        size="small"
        columns={columns}
        dataSource={result.results.map((r, i) => ({ ...r, key: r.operationId || i }))}
        pagination={{ pageSize: PAGE_SIZES.DEFAULT }}
      />
    </Space>
  );
};
