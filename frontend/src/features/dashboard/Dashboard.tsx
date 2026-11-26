/**
 * Dashboard — answers "Is my organization's access in order right now?"
 *
 * One flat KPI band (real data only), a "Needs attention" feed and connector
 * health. Numbers count up once on the first visit of the session.
 */
import React, { useEffect, useState } from 'react';
import { Card, Col, Row, Typography, Tag, Skeleton, theme } from 'antd';
import { CheckCircleOutlined, RightOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { reconciliationKeys, fetchConnectorHealth, fetchDriftStats } from '@api/reconciliation-api';
import {
  intelligenceKeys,
  fetchRiskScoreDistribution,
  fetchAnomalies,
  fetchCampaigns,
} from '@api/intelligence-api';
import type { IConnectorHealthStatus } from '../../interfaces/reconciliation.interface';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { KpiBand, type KpiItem } from '@shared/KpiBand';

const { Text } = Typography;

/** The KPI count-up plays on the first dashboard visit of the session only. */
let kpiCountUpPlayed = false;

// ── Hook: dashboard data ─────────────────────────────────────────────────────

function useDashboardData() {
  const identityTotal = useQuery({
    queryKey: ['dashboard', 'identity-total'],
    queryFn: async () => {
      const res = await axiosInstance.get(`${API_BASE}/identity`, {
        params: { _start: 0, _end: 1 },
      });
      // The list endpoint reports the full count in X-Total-Count; the body is one page.
      const total = Number(res.headers?.['x-total-count']);
      return Number.isFinite(total) ? total : null;
    },
    staleTime: 60_000,
  });

  // Open drifts only, the query of the Drift dashboard's "Open drifts" card (same key, same data).
  const driftStats = useQuery({
    queryKey: reconciliationKeys.driftStats(),
    queryFn: fetchDriftStats,
    staleTime: 30_000,
  });

  const activeCampaigns = useQuery({
    queryKey: intelligenceKeys.campaigns({ status: 'ACTIVE', limit: 1 }),
    queryFn: () => fetchCampaigns({ status: 'ACTIVE', limit: 1 }),
    staleTime: 60_000,
  });

  const riskDistribution = useQuery({
    queryKey: intelligenceKeys.riskScoreDistribution(),
    queryFn: fetchRiskScoreDistribution,
    staleTime: 60_000,
  });

  const anomalies = useQuery({
    queryKey: intelligenceKeys.anomalies({ status: 'open', limit: 5 }),
    queryFn: () => fetchAnomalies({ status: 'open', limit: 5 }),
    staleTime: 30_000,
  });

  const connectorHealth = useQuery({
    queryKey: reconciliationKeys.connectorHealth(),
    queryFn: fetchConnectorHealth,
    staleTime: 30_000,
  });

  return {
    identityTotal,
    driftStats,
    activeCampaigns,
    riskDistribution,
    anomalies,
    connectorHealth,
  };
}

// ── Needs attention ──────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low';

interface AttentionItem {
  key: string;
  title: string;
  description: string;
  severity: Severity;
  navigateTo: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const AttentionRow: React.FC<{ item: AttentionItem; color: string; last: boolean }> = ({
  item,
  color,
  last,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="euroid-row-action"
      onClick={() => navigate(item.navigateTo)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        width: '100%',
        padding: '14px 20px',
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        borderBottom: last ? 'none' : `1px solid ${token.colorBorderSecondary}`,
        background: 'transparent',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <Text strong style={{ display: 'block' }}>
          {item.title}
        </Text>
        <Text type="secondary" style={{ fontSize: 13 }}>
          {item.description}
        </Text>
      </span>
      <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
        {SEVERITY_LABEL[item.severity]}
      </Text>
      <RightOutlined aria-hidden style={{ fontSize: 11, color: token.colorTextTertiary }} />
    </button>
  );
};

// ── Component ────────────────────────────────────────────────────────────────

export const Dashboard: React.FC = () => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const {
    identityTotal,
    driftStats,
    activeCampaigns,
    riskDistribution,
    anomalies,
    connectorHealth,
  } = useDashboardData();
  const [countUp] = useState(() => !kpiCountUpPlayed);

  const kpiLoading =
    identityTotal.isLoading ||
    driftStats.isLoading ||
    activeCampaigns.isLoading ||
    riskDistribution.isLoading;

  useEffect(() => {
    if (!kpiLoading) kpiCountUpPlayed = true;
  }, [kpiLoading]);

  const openDrifts = driftStats.isError ? null : (driftStats.data?.total ?? 0);
  const avgRisk = riskDistribution.isError ? null : (riskDistribution.data?.average ?? null);

  const kpis: KpiItem[] = [
    {
      key: 'identities',
      label: 'Identities',
      value: identityTotal.isError ? null : (identityTotal.data ?? null),
      context: 'Golden records in the hub',
      onClick: () => navigate('/users'),
      actionLabel: 'Identities: open Identity hub',
    },
    {
      key: 'drifts',
      label: 'Open drifts',
      value: openDrifts,
      tone: openDrifts ? 'warning' : 'default',
      context: openDrifts ? 'Targets differ from desired state' : 'Targets match desired state',
      onClick: () => navigate('/reconciliation'),
      actionLabel: 'Open drifts: open Reconciliation',
    },
    {
      key: 'reviews',
      label: 'Active access reviews',
      value: activeCampaigns.isError ? null : (activeCampaigns.data?.total ?? 0),
      context: 'Certification campaigns running',
      onClick: () => navigate('/intelligence/reviews'),
      actionLabel: 'Active access reviews: open Access reviews',
    },
    {
      key: 'risk',
      label: 'Average risk score',
      value: avgRisk,
      decimals: avgRisk != null && !Number.isInteger(avgRisk) ? 1 : 0,
      suffix: avgRisk != null ? '/ 100' : undefined,
      tone: avgRisk != null && avgRisk >= 70 ? 'error' : 'default',
      context: 'Across all scored identities',
      onClick: () => navigate('/intelligence/risk'),
      actionLabel: 'Average risk score: open Risk dashboard',
    },
  ];

  // Attention feed from live data
  const attentionItems: AttentionItem[] = [];
  if (openDrifts && openDrifts > 0) {
    attentionItems.push({
      key: 'drifts',
      title: `${openDrifts} open drift${openDrifts > 1 ? 's' : ''}`,
      description: 'Source and target systems are out of sync',
      severity: openDrifts > 10 ? 'high' : 'medium',
      navigateTo: '/reconciliation',
    });
  }
  const anomalyData = anomalies.data?.data ?? [];
  if (anomalyData.length > 0) {
    const critCount = anomalyData.filter((a) => a.severity === 'critical').length;
    attentionItems.push({
      key: 'anomalies',
      title: `${anomalyData.length} open anomal${anomalyData.length > 1 ? 'ies' : 'y'}${critCount > 0 ? `, ${critCount} critical` : ''}`,
      description: 'Unusual access patterns detected',
      severity: critCount > 0 ? 'critical' : 'high',
      navigateTo: '/intelligence/risk',
    });
  }
  const connectors = connectorHealth.data ?? [];
  const unhealthy = connectors.filter((c: IConnectorHealthStatus) => c.status !== 'healthy');
  if (unhealthy.length > 0) {
    attentionItems.push({
      key: 'connectors',
      title: `${unhealthy.length} connector${unhealthy.length > 1 ? 's' : ''} not healthy`,
      description: unhealthy.map((c) => c.connectorName).join(', '),
      severity: unhealthy.some((c) => c.status === 'down') ? 'high' : 'medium',
      navigateTo: '/reconciliation',
    });
  }
  attentionItems.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const severityColor: Record<Severity, string> = {
    critical: token.colorError,
    high: token.colorError,
    medium: token.colorWarning,
    low: token.colorInfo,
  };
  const healthColor: Record<IConnectorHealthStatus['status'], string> = {
    healthy: token.colorSuccess,
    degraded: token.colorWarning,
    down: token.colorError,
    unknown: token.colorTextQuaternary,
  };
  const healthLabel: Record<IConnectorHealthStatus['status'], string> = {
    healthy: 'Healthy',
    degraded: 'Degraded',
    down: 'Down',
    unknown: 'Unknown',
  };

  const feedLoading = driftStats.isLoading || anomalies.isLoading || connectorHealth.isLoading;

  return (
    <PageContainer>
      <PageHeader title="Dashboard" subtitle="Access health across your organization" />

      <KpiBand items={kpis} loading={kpiLoading} countUp={countUp} />

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={15}>
          <Card
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                Needs attention
                {attentionItems.length > 0 && (
                  <Tag bordered={false} className="tabular-nums" style={{ margin: 0 }}>
                    {attentionItems.length}
                  </Tag>
                )}
              </span>
            }
            styles={{ body: { padding: 0 } }}
            style={{ height: '100%' }}
          >
            {feedLoading ? (
              <Skeleton active paragraph={{ rows: 3 }} style={{ padding: 20 }} />
            ) : attentionItems.length === 0 ? (
              <div style={{ padding: '32px 20px', textAlign: 'center' }}>
                <CheckCircleOutlined style={{ fontSize: 24, color: token.colorSuccess }} />
                <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                  All clear. Nothing needs immediate attention.
                </Text>
              </div>
            ) : (
              <nav aria-label="Needs attention">
                {attentionItems.map((item, i) => (
                  <AttentionRow
                    key={item.key}
                    item={item}
                    color={severityColor[item.severity]}
                    last={i === attentionItems.length - 1}
                  />
                ))}
              </nav>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card
            title="Connector health"
            styles={{ body: { padding: '4px 20px' } }}
            style={{ height: '100%' }}
          >
            {connectorHealth.isLoading ? (
              <Skeleton active paragraph={{ rows: 4 }} style={{ padding: '12px 0' }} />
            ) : connectors.length === 0 ? (
              <Text type="secondary" style={{ display: 'block', padding: '16px 0' }}>
                No connectors configured
              </Text>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {connectors.map((c, i) => {
                  const status = c.status ?? 'unknown';
                  return (
                    <li
                      key={c.connectorId ?? i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 0',
                        borderBottom:
                          i === connectors.length - 1
                            ? 'none'
                            : `1px solid ${token.colorBorderSecondary}`,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: healthColor[status],
                          flexShrink: 0,
                        }}
                      />
                      <Text style={{ flex: 1, minWidth: 0 }} ellipsis>
                        {c.connectorName || `Connector ${i + 1}`}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {healthLabel[status]}
                      </Text>
                      {typeof c.uptime === 'number' && (
                        <Text
                          type="secondary"
                          className="tabular-nums"
                          style={{ fontSize: 12, width: 56, textAlign: 'right' }}
                        >
                          {c.uptime.toFixed(c.uptime >= 99.95 ? 0 : 2)}%
                        </Text>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};
