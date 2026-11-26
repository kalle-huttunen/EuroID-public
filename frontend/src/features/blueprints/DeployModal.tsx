/**
 * DeployModal — Pre-deploy readiness check and deploy confirmation
 *
 * Shows checklist of conditions before deploying the pipeline.
 * Allows configuring error threshold for circuit breaker.
 *
 * Security (Safety Rule — destructive actions): The modal itself serves as
 * confirmation. User must explicitly open the modal, review readiness checks,
 * and click "Deploy Now". Readiness checks act as a simulation gate. No separate
 * Modal.confirm is required; the modal + readiness check satisfies the rule.
 */
import React, { useState, useEffect } from 'react';
import {
  Modal,
  Space,
  Button,
  Typography,
  List,
  Tag,
  Select,
  Spin,
  Alert,
  Checkbox,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { BRAND } from '../../theme';

const { Text } = Typography;

export interface ReadinessCheckItem {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  /** Deploy needs the deployer's confirmation of this check (a critical-risk impact analysis). */
  acknowledgementRequired?: boolean;
}

export interface ReadinessCheckResult {
  ready: boolean;
  checks: ReadinessCheckItem[];
}

export interface PipelineConfig {
  status: string;
  deployedAt?: string;
  deployedBy?: string;
  errorThresholdPercent?: number;
  minSampleSizeForCircuitBreaker?: number;
  lastSimulationRisk?: string;
}

export interface DeployModalProps {
  open: boolean;
  onClose: () => void;
  onDeployed: () => void;
  pipelineConfig?: PipelineConfig;
}

const statusIcon = (status: string) => {
  if (status === 'pass') return <CheckCircleOutlined style={{ color: BRAND.success }} />;
  if (status === 'fail') return <CloseCircleOutlined style={{ color: BRAND.error }} />;
  return <WarningOutlined style={{ color: BRAND.warning }} />;
};

export const DeployModal: React.FC<DeployModalProps> = ({
  open,
  onClose,
  onDeployed,
  pipelineConfig,
}) => {
  const [loading, setLoading] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessCheckResult | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [errorThreshold, setErrorThreshold] = useState(pipelineConfig?.errorThresholdPercent ?? 5);
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const needsConfirmation = !!readiness?.checks.some((c) => c.acknowledgementRequired);

  useEffect(() => {
    if (open) {
      setErrorThreshold(pipelineConfig?.errorThresholdPercent ?? 5);
      setRiskConfirmed(false);
      fetchReadiness();
    }
  }, [open, pipelineConfig?.errorThresholdPercent]);

  const fetchReadiness = async () => {
    setLoading(true);
    try {
      const { data } = await axiosInstance.post<ReadinessCheckResult>(
        `${API_BASE}/blueprints/readiness-check`,
      );
      setReadiness(data);
    } catch (err) {
      console.error('Readiness check failed:', err);
      message.error('Failed to run readiness check');
      setReadiness({ ready: false, checks: [] });
    } finally {
      setLoading(false);
    }
  };

  const handleDeploy = async () => {
    if (!readiness?.ready || (needsConfirmation && !riskConfirmed)) return;
    setDeploying(true);
    try {
      if (errorThreshold !== (pipelineConfig?.errorThresholdPercent ?? 5)) {
        await axiosInstance.patch(`${API_BASE}/blueprints/pipeline-config`, {
          errorThresholdPercent: errorThreshold,
        });
      }
      // The API refuses a critical-risk impact analysis that is not confirmed (422)
      await axiosInstance.post(
        `${API_BASE}/blueprints/deploy`,
        needsConfirmation ? { acknowledgeCriticalRisk: true } : {},
      );
      message.success('Pipeline deployed successfully');
      onDeployed();
      onClose();
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          data?: { statusCode?: number; readiness?: ReadinessCheckResult; message?: string };
        };
      };
      const res = axiosErr?.response?.data;
      if (res?.statusCode === 422 && res?.readiness) {
        setReadiness(res.readiness);
        message.error('Readiness check failed. Please fix the issues and try again.');
      } else {
        message.error(res?.message ?? 'Failed to deploy pipeline');
      }
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Modal
      title={
        <Space>
          <RocketOutlined />
          Deploy Pipeline
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="deploy"
          type="primary"
          loading={deploying}
          disabled={!readiness?.ready || deploying || (needsConfirmation && !riskConfirmed)}
          onClick={handleDeploy}
          icon={<RocketOutlined />}
        >
          Deploy Now
        </Button>,
      ]}
      width={520}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Text type="secondary">Pre-flight checks:</Text>
        {loading ? (
          <Spin />
        ) : readiness ? (
          <List
            size="small"
            dataSource={readiness.checks}
            renderItem={(item) => (
              <List.Item>
                <Space>
                  {statusIcon(item.status)}
                  <span>{item.message}</span>
                  {item.status === 'warn' && <Tag color="warning">Warning</Tag>}
                </Space>
              </List.Item>
            )}
          />
        ) : null}

        {readiness?.ready && needsConfirmation && (
          <Checkbox checked={riskConfirmed} onChange={(e) => setRiskConfirmed(e.target.checked)}>
            I reviewed the impact analysis and deploy despite its critical risk
          </Checkbox>
        )}

        {readiness && !readiness.ready && (
          <Alert
            type="error"
            message="Cannot deploy"
            description="Fix all failed checks before deploying."
          />
        )}

        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text strong>Error threshold</Text>
          <Select
            value={errorThreshold}
            onChange={setErrorThreshold}
            options={[
              { value: 2, label: '2%' },
              { value: 5, label: '5%' },
              { value: 10, label: '10%' },
              { value: 15, label: '15%' },
              { value: 20, label: '20%' },
            ]}
            style={{ width: 120 }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Pipeline will auto-pause if error rate exceeds this threshold.
          </Text>
        </Space>
      </Space>
    </Modal>
  );
};
