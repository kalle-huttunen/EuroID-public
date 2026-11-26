import React, { useEffect, useState } from 'react';
import { Modal, Timeline, Progress, Typography, Space, Tag, Alert, theme } from 'antd';
import { API_BASE } from '@api/constants';
import { axiosInstance } from '@api/data';
import { POLL_INTERVALS } from '@config/polling';
import {
  LoadingOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

/** Temporal statuses of a workflow that has closed: polling stops. */
const CLOSED_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'];
/** Tag colour per status: only COMPLETED is a success. */
const STATUS_COLORS: Record<string, string> = {
  RUNNING: 'blue',
  COMPLETED: 'green',
  FAILED: 'red',
  TERMINATED: 'red',
  TIMED_OUT: 'red',
  CANCELLED: 'orange',
};

interface WorkflowStatus {
  workflowId: string;
  currentStep: string;
  status: string;
  percent: number;
  startTime: string;
}

interface ProvisioningProgressProps {
  visible: boolean;
  onClose: () => void;
  userName?: string;
  workflowId?: string;
}

export const ProvisioningProgress: React.FC<ProvisioningProgressProps> = ({
  visible,
  onClose,
  userName = 'User',
  workflowId,
}) => {
  const { token } = theme.useToken();
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll the backend for real-time workflow status
  useEffect(() => {
    if (!visible || !workflowId) return;
    let isMounted = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const pollStatus = async () => {
      try {
        const { data } = await axiosInstance.get<WorkflowStatus>(
          `${API_BASE}/onboarding/status/${workflowId}`,
        );
        if (!isMounted) return;
        setStatus(data);
        setError(null);

        // Stop polling if workflow is done
        if (CLOSED_STATUSES.includes(data.status) && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      } catch (err) {
        if (!isMounted) return;
        const msg = import.meta.env.PROD
          ? 'Unable to load status. Please try again.'
          : err instanceof Error
            ? err.message
            : 'Unknown error';
        setError(msg);
      }
    };

    // Initial fetch
    pollStatus();
    intervalId = setInterval(pollStatus, POLL_INTERVALS.PROVISIONING_MS);

    return () => {
      isMounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [visible, workflowId]);

  // Map workflow steps to UI timeline
  const getStepStatus = (stepKey: string) => {
    if (!status) return 'wait';

    const stepOrder = [
      'INITIALIZING',
      'DISCOVERING_SYSTEMS',
      'HEALTH_CHECK',
      'HR_SYNC',
      'HUB_SAVE',
      'POLICY_CALC',
      'TARGET_PUSH',
      'COMPLETED',
    ];

    const currentIndex = stepOrder.indexOf(status.currentStep);
    const stepIndex = stepOrder.indexOf(stepKey);

    if (currentIndex > stepIndex) return 'finish';
    if (currentIndex === stepIndex) return 'process';
    return 'wait';
  };

  // 2026 Style: Mapping workflow steps to the UI spoke model
  const steps = [
    {
      key: 'HR_SYNC',
      title: 'Step A: HR Source Sync',
      subtitle: 'Fetching new hires from source system',
      status: getStepStatus('HR_SYNC'),
    },
    {
      key: 'HUB_SAVE',
      title: 'Step B: Hub Record Secured',
      subtitle: 'Creating canonical identity record',
      status: getStepStatus('HUB_SAVE'),
    },
    {
      key: 'POLICY_CALC',
      title: 'Step C: Policy Engine Decision',
      subtitle: 'Calculating access rights and compliance',
      status: getStepStatus('POLICY_CALC'),
    },
    {
      key: 'TARGET_PUSH',
      title: 'Step D: Target Provisioning',
      subtitle: 'Pushing to Entra ID and other target systems',
      status: getStepStatus('TARGET_PUSH'),
    },
  ];

  const getStepIcon = (stepStatus: string) => {
    switch (stepStatus) {
      case 'finish':
        return <CheckCircleOutlined />;
      case 'process':
        return <SyncOutlined spin />;
      default:
        return <ClockCircleOutlined />;
    }
  };

  return (
    <Modal
      title={<Title level={4}>Provisioning Journey: {userName}</Title>}
      open={visible}
      onCancel={onClose}
      footer={null}
      width={600}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        {error && <Alert message="Connection Error" description={error} type="error" showIcon />}

        <Progress
          percent={status?.percent || 0}
          status={status?.status === 'FAILED' ? 'exception' : 'active'}
          strokeColor={{ '0%': token.colorPrimary, '100%': token.colorSuccess }}
        />

        <Timeline mode="left">
          {steps.map((step) => (
            <Timeline.Item
              key={step.key}
              dot={getStepIcon(step.status)}
              color={
                step.status === 'finish' ? 'green' : step.status === 'process' ? 'blue' : 'gray'
              }
            >
              <Text strong>{step.title}</Text>
              <br />
              <Text type="secondary" style={{ fontSize: '12px' }}>
                {step.status === 'finish'
                  ? '✓ Completed'
                  : step.status === 'process'
                    ? `⚡ ${step.subtitle}...`
                    : '⏳ Waiting'}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>

        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Tag color="processing" icon={<SyncOutlined spin />}>
            Temporal Workflow ID: {workflowId || 'N/A'}
          </Tag>
          {status && (
            <>
              <Tag color={STATUS_COLORS[status.status] ?? 'default'}>Status: {status.status}</Tag>
              <Tag color="default">Current Step: {status.currentStep}</Tag>
            </>
          )}
        </Space>
      </Space>
    </Modal>
  );
};
