/**
 * ConnectorHealth – grid of health cards per connector.
 * Status dot, uptime, rate limit bar, credential expiry, Check Now.
 * TODO: "View Logs" hidden until connector logs API exists (see CURRENT_TASK.md §1.2).
 */

import React, { useState } from "react";
import {
  Card,
  Row,
  Col,
  Tag,
  Typography,
  Button,
  Space,
  Progress,
  Alert,
  Skeleton,
  theme,
} from "antd";
import {
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { IConnectorHealthStatus } from "../../interfaces";
import { relativeTimeNullable } from "../../utils/date-helpers";
import { EmptyState } from '../../components/common/EmptyState';

const { Text } = Typography;

// ── Helpers ─────────────────────────────────────────────────────────────

interface StatusDotColors {
  healthy: string;
  degraded: string;
  down: string;
  unknown: string;
}

function statusDot(status: IConnectorHealthStatus["status"], colors: StatusDotColors) {
  const map = {
    healthy: { color: colors.healthy, icon: <CheckCircleOutlined /> },
    degraded: { color: colors.degraded, icon: <WarningOutlined /> },
    down: { color: colors.down, icon: <CloseCircleOutlined /> },
    unknown: { color: colors.unknown, icon: <QuestionCircleOutlined /> },
  };
  const { color, icon } = map[status];
  return <span style={{ color, marginRight: 8 }}>{icon}</span>;
}

function credentialWarning(expiresAt?: string): "ok" | "soon" | "critical" | null {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  const now = new Date();
  const days = (d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  if (days < 0) return "critical";
  if (days <= 7) return "critical";
  if (days <= 30) return "soon";
  return "ok";
}

// ── Props ───────────────────────────────────────────────────────────────

export interface ConnectorHealthProps {
  healthList?: IConnectorHealthStatus[];
  loading?: boolean;
  onCheckNow?: (connectorId: string) => Promise<void>;
}

// ── Single health card ──────────────────────────────────────────────────

const HealthCard: React.FC<{
  item: IConnectorHealthStatus;
  onCheckNow?: (connectorId: string) => Promise<void>;
}> = ({ item, onCheckNow }) => {
  const { token } = theme.useToken();
  const [checking, setChecking] = useState(false);
  const cred = credentialWarning(item.credentialExpiresAt);
  const ratePct =
    item.rateLimitTotal && item.rateLimitRemaining != null
      ? Math.round((item.rateLimitRemaining / item.rateLimitTotal) * 100)
      : null;

  const handleCheckNow = async () => {
    if (!onCheckNow) return;
    setChecking(true);
    try {
      await onCheckNow(item.connectorId);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          {statusDot(item.status, {
            healthy: token.colorSuccess,
            degraded: token.colorWarning,
            down: token.colorError,
            unknown: token.colorBorder,
          })}
          <span>{item.connectorName}</span>
        </Space>
      }
      extra={
        <Space>
          <Button
            size="small"
            icon={<ReloadOutlined spin={checking} />}
            onClick={handleCheckNow}
            loading={checking}
          >
            Check Now
          </Button>
          {/* View Logs: hidden until connector logs API exists – CURRENT_TASK §1.2 */}
        </Space>
      }
      style={{ height: "100%" }}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="small">
        <div>
          <Text type="secondary">Status: </Text>
          <Tag color={item.status === "healthy" ? "green" : item.status === "down" ? "red" : item.status === "degraded" ? "orange" : "default"}>
            {item.status}
          </Tag>
        </div>
        <div>
          <Text type="secondary">Uptime: </Text>
          <Text strong>{item.uptime != null ? `${item.uptime}%` : "n/a"}</Text>
        </div>
        {item.responseTimeMs != null && (
          <div>
            <Text type="secondary">Response time: </Text>
            <Text>{item.responseTimeMs} ms</Text>
          </div>
        )}
        {ratePct != null && item.rateLimitTotal != null && item.rateLimitRemaining != null && (
          <div>
            <Text type="secondary">Rate limit: </Text>
            <Progress
              percent={ratePct}
              size="small"
              status={ratePct < 20 ? "exception" : ratePct < 50 ? "normal" : undefined}
              format={() => `${item.rateLimitRemaining}/${item.rateLimitTotal}`}
            />
          </div>
        )}
        {item.credentialExpiresAt && (
          <div>
            <Text type="secondary">Credentials expire: </Text>
            <Text>{new Date(item.credentialExpiresAt).toLocaleDateString()}</Text>
            {cred === "soon" && (
              <Alert
                type="warning"
                message="Expires within 30 days"
                showIcon
                style={{ marginTop: 8 }}
              />
            )}
            {cred === "critical" && (
              <Alert
                type="error"
                message="Expires within 7 days or expired"
                showIcon
                style={{ marginTop: 8 }}
              />
            )}
          </div>
        )}
        <div>
          <Text type="secondary">Last checked: </Text>
          <Text>{relativeTimeNullable(item.lastChecked)}</Text>
        </div>
        {item.lastError && (
          <Alert type="info" message={item.lastError} showIcon style={{ marginTop: 4 }} />
        )}
      </Space>
    </Card>
  );
};

// ── Component ────────────────────────────────────────────────────────────

export const ConnectorHealth: React.FC<ConnectorHealthProps> = ({
  healthList = [],
  loading = false,
  onCheckNow,
}) => {
  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Row gutter={[16, 16]}>
          {[1, 2, 3, 4].map((i) => (
            <Col xs={24} sm={12} lg={8} xl={6} key={i}>
              <Card>
                <Skeleton active paragraph={{ rows: 5 }} />
              </Card>
            </Col>
          ))}
        </Row>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <Row gutter={[16, 16]}>
        {healthList.map((item) => (
          <Col xs={24} sm={12} lg={8} xl={6} key={item.connectorId}>
            <HealthCard item={item} onCheckNow={onCheckNow} />
          </Col>
        ))}
      </Row>
      {healthList.length === 0 && (
        <EmptyState
          title="No connectors registered"
          description="Add connectors in Design Studio to start syncing identities."
        />
      )}
    </div>
  );
};

