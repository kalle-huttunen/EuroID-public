/**
 * RiskScoreTable — Top 20 Risky Users table with expandable factor breakdown
 */

import React from 'react';
import { Card, Table, Skeleton, Row, Col, Space, Typography, Tag, theme } from 'antd';
import { EmptyState } from '../../components/common/EmptyState';
import type { ColumnsType } from 'antd/es/table';
import { ArrowUpOutlined, ArrowDownOutlined, MinusOutlined } from '@ant-design/icons';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis } from 'recharts';
import dayjs from 'dayjs';
import { factorLabel } from './hooks/useRiskScoreEnrichment';
import type { EnrichedRiskScore } from './hooks/useRiskScoreEnrichment';

/** Below this the table scrolls sideways in its card instead of squeezing the columns. */
const RISK_TABLE_MIN_WIDTH = 900;

function getRiskScoreColor(score: number): string {
  if (score <= 25) return 'green';
  if (score <= 50) return 'gold';
  if (score <= 75) return 'orange';
  return 'red';
}

interface RiskScoreTableProps {
  enrichedRiskScores: EnrichedRiskScore[];
  riskScoresLoading: boolean;
  riskScoresFullLoading: boolean;
  useFullScores: boolean;
}

export const RiskScoreTable: React.FC<RiskScoreTableProps> = ({
  enrichedRiskScores,
  riskScoresLoading,
  riskScoresFullLoading,
  useFullScores,
}) => {
  const { token } = theme.useToken();

  const renderTrendIcon = (trend: string | undefined) => {
    if (!trend) return null;
    if (trend === 'INCREASING' || trend === 'DECREASING' || trend === 'STABLE') {
      const icon =
        trend === 'INCREASING' ? (
          <ArrowUpOutlined style={{ color: token.colorError }} />
        ) : trend === 'DECREASING' ? (
          <ArrowDownOutlined style={{ color: token.colorSuccess }} />
        ) : (
          <MinusOutlined style={{ color: token.colorTextSecondary }} />
        );
      return <span title={trend}>{icon}</span>;
    }
    return null;
  };

  const columns: ColumnsType<EnrichedRiskScore> = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Department', dataIndex: 'department', key: 'department' },
    {
      title: 'Risk Score',
      dataIndex: 'score',
      key: 'score',
      sorter: (a, b) => (a.score ?? 0) - (b.score ?? 0),
      render: (score: number) => <Tag color={getRiskScoreColor(score ?? 0)}>{score ?? 0}</Tag>,
    },
    {
      title: 'Trend',
      dataIndex: 'trend',
      key: 'trend',
      render: (_: unknown, record: EnrichedRiskScore) => renderTrendIcon(record.trend),
    },
    {
      title: 'Top Factors',
      dataIndex: 'topFactors',
      key: 'topFactors',
      ellipsis: true,
      render: (t: string) => (t ? <Typography.Text type="secondary">{t}</Typography.Text> : '-'),
    },
    {
      title: 'Open Anomalies',
      dataIndex: 'openAnomalies',
      key: 'openAnomalies',
      render: (n: number) => (n > 0 ? <Tag color="red">{n}</Tag> : '-'),
    },
  ];

  return (
    <Card title="Top 20 Risky Users" style={{ marginBottom: 24 }}>
      {riskScoresLoading && !riskScoresFullLoading ? (
        <Skeleton active />
      ) : enrichedRiskScores.length === 0 ? (
        <EmptyState
          title="No risk scores yet"
          description={
            useFullScores
              ? 'Nightly calculation runs at 2 AM.'
              : 'Run anomaly analysis to get started.'
          }
        />
      ) : (
        <Table
          columns={columns}
          dataSource={enrichedRiskScores}
          rowKey="identityId"
          scroll={{ x: RISK_TABLE_MIN_WIDTH }}
          pagination={false}
          size="small"
          expandable={{
            expandedRowRender: (record) => {
              const hasFactors = (record.factors?.length ?? 0) > 0;
              const hasHistory = (record.history?.length ?? 0) > 0;
              if (!hasFactors && !hasHistory) {
                return (
                  <Typography.Text type="secondary">No factor breakdown available.</Typography.Text>
                );
              }
              return (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  {hasFactors && record.factors && (
                    <div>
                      <Typography.Text strong>Factor Breakdown</Typography.Text>
                      <Row gutter={[16, 8]} style={{ marginTop: 8 }}>
                        {record.factors.map((f) => (
                          <Col key={f.factor} xs={24} sm={12} md={8}>
                            <Typography.Text type="secondary">
                              {factorLabel(f.factor)}:{' '}
                            </Typography.Text>
                            <Typography.Text>
                              raw={f.rawValue}, contrib={f.contribution.toFixed(1)}
                            </Typography.Text>
                          </Col>
                        ))}
                      </Row>
                    </div>
                  )}
                  {hasHistory && record.history && (
                    <div>
                      <Typography.Text strong>30-Day Trend</Typography.Text>
                      <div style={{ height: 80, marginTop: 8 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart
                            data={record.history.map((h) => ({
                              date: dayjs(h.date).format('MM/DD'),
                              score: h.score,
                            }))}
                            margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
                          >
                            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                            <YAxis domain={[0, 100]} width={28} tick={{ fontSize: 10 }} />
                            <Line
                              type="monotone"
                              dataKey="score"
                              stroke={token.colorPrimary}
                              dot={false}
                              strokeWidth={2}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </Space>
              );
            },
          }}
        />
      )}
    </Card>
  );
};
