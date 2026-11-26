/**
 * Live progress view for bulk provisioning. Polls status and partial results; shows approval gate for deletes.
 */
import React, { useEffect, useState } from 'react';
import { Progress, Alert, Button, Table, Space, Typography, Spin, theme } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { axiosInstance } from '@api/data';
import { BULK_PROVISIONING_API } from '@config/api-routes';
import { POLL_INTERVALS } from '@config/polling';
import { PAGE_SIZES } from '@config/pagination';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;

export interface ProgressState {
  workflowId: string;
  status: string;
  currentPhase: string;
  progress?: {
    phase: string;
    currentOperation: number;
    totalOperations: number;
    percentComplete: number;
    operationsSuccessful: number;
    operationsFailed: number;
    estimatedTimeRemainingMs: number;
  };
}

interface BulkProgressProps {
  workflowId: string | null;
  onComplete: () => void;
}

export const BulkProgress: React.FC<BulkProgressProps> = ({ workflowId, onComplete }) => {
  const { token } = theme.useToken();
  const [state, setState] = useState<ProgressState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [partialResults, setPartialResults] = useState<
    Array<{ operationId: string; success?: boolean; email?: string; error?: string }>
  >([]);

  const poll = React.useCallback(async () => {
    if (!workflowId) return;
    try {
      const [statusRes, partialRes] = await Promise.all([
        axiosInstance.get(`${BULK_PROVISIONING_API}/status/${encodeURIComponent(workflowId)}`),
        axiosInstance.get(
          `${BULK_PROVISIONING_API}/partial-results/${encodeURIComponent(workflowId)}`,
        ),
      ]);
      const statusJson = statusRes.data;
      setState({
        workflowId,
        status: statusJson.status ?? 'UNKNOWN',
        currentPhase: statusJson.currentPhase ?? statusJson.progress?.phase ?? '—',
        progress: statusJson.progress ?? undefined,
      });
      const partialJson = partialRes.data;
      const results = partialJson?.results ?? partialJson ?? [];
      setPartialResults(Array.isArray(results) ? results : []);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, 'Poll failed'));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId) return;
    setLoading(true);
    poll();
    const interval = setInterval(poll, POLL_INTERVALS.PROVISIONING_MS);
    return () => clearInterval(interval);
  }, [workflowId, poll]);

  useEffect(() => {
    if (!state) return;
    const done = ['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'].includes(
      state.status,
    );
    if (done) onComplete();
  }, [state?.status, onComplete]);

  const approveDeletes = async () => {
    if (!workflowId) return;
    setApproving(true);
    try {
      await axiosInstance.post(
        `${BULK_PROVISIONING_API}/approve-deletes/${encodeURIComponent(workflowId)}`,
      );
      await poll();
    } catch (e) {
      setError(apiErrorMessage(e, 'Approve failed'));
    } finally {
      setApproving(false);
    }
  };

  const cancelWorkflow = async () => {
    if (!workflowId) return;
    setCancelling(true);
    try {
      await axiosInstance.post(`${BULK_PROVISIONING_API}/cancel/${encodeURIComponent(workflowId)}`);
      await poll();
    } catch (e) {
      setError(apiErrorMessage(e, 'Cancel failed'));
    } finally {
      setCancelling(false);
    }
  };

  const phase = state?.currentPhase ?? state?.progress?.phase ?? '—';
  const progressPercent = state?.progress?.percentComplete ?? 0;
  const totalOps = state?.progress?.totalOperations ?? 0;
  // The workflow counts every processed operation in currentOperation (successes included)
  const completedOps = state?.progress?.currentOperation ?? 0;
  const failedOps = state?.progress?.operationsFailed ?? 0;
  const awaitingApproval = phase === 'AWAITING_DELETE_APPROVAL';
  const estimatedSec = state?.progress?.estimatedTimeRemainingMs
    ? Math.round(state.progress.estimatedTimeRemainingMs / 1000)
    : undefined;

  if (!workflowId) {
    return (
      <Alert message="No workflow started. Go back to Preview and click Execute." type="info" />
    );
  }

  if (loading && !state) {
    return (
      <Spin size="large" tip="Loading progress…">
        <div style={{ minHeight: 200 }} />
      </Spin>
    );
  }

  // Nothing to show yet: the error alone. Otherwise the panel stays (Approve deletes, Cancel)
  // with the error above it until the next poll succeeds.
  if (error && !state) {
    return <Alert message={error} type="error" showIcon />;
  }

  const partialColumns = [
    { title: 'Operation', dataIndex: 'operationId', key: 'operationId', ellipsis: true },
    { title: 'Email', dataIndex: 'email', key: 'email', ellipsis: true },
    {
      title: 'Status',
      key: 'status',
      render: (_: unknown, r: { success?: boolean; error?: string }) =>
        r.success === true ? (
          <CheckCircleOutlined style={{ color: token.colorSuccess }} />
        ) : r.success === false ? (
          <CloseCircleOutlined style={{ color: token.colorError }} />
        ) : (
          '—'
        ),
    },
    { title: 'Error', dataIndex: 'error', key: 'error', ellipsis: true },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error && <Alert message={error} type="error" showIcon />}
      <Progress
        type="line"
        percent={progressPercent}
        status={state?.status === 'FAILED' ? 'exception' : undefined}
        format={() => `${progressPercent}%`}
      />
      <div>
        <Text strong>Phase: </Text>
        <Text>{phase}</Text>
        {estimatedSec != null && estimatedSec > 0 && (
          <Text type="secondary" style={{ marginLeft: 8 }}>
            ~{estimatedSec}s remaining
          </Text>
        )}
      </div>
      <div>
        <Text>
          Completed: {completedOps} / {totalOps}
        </Text>
        {failedOps > 0 && (
          <Text type="danger" style={{ marginLeft: 8 }}>
            Failed: {failedOps}
          </Text>
        )}
      </div>

      {awaitingApproval && (
        <Alert
          message="Delete operations require your approval"
          description={
            <Space>
              <Button type="primary" onClick={approveDeletes} loading={approving}>
                Approve deletes
              </Button>
              <Button danger onClick={cancelWorkflow} loading={cancelling}>
                Cancel workflow
              </Button>
            </Space>
          }
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
        />
      )}

      {!awaitingApproval && ['RUNNING', 'ACTIVE'].includes(state?.status ?? '') && (
        <Button danger onClick={cancelWorkflow} loading={cancelling}>
          Cancel workflow
        </Button>
      )}

      {partialResults.length > 0 && (
        <>
          <Text strong>Partial results</Text>
          <Table
            size="small"
            columns={partialColumns}
            dataSource={partialResults.map((r, i) => ({ ...r, key: r.operationId ?? i }))}
            pagination={{ pageSize: PAGE_SIZES.DEFAULT }}
          />
        </>
      )}
    </Space>
  );
};
