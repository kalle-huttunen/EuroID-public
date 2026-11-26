/**
 * Risk Dashboard — Intelligence Layer
 *
 * Shows anomalies and risk scores. Operators acknowledge and dismiss from the list and
 * acknowledge, resolve or dismiss in the anomaly modal; a super-admin runs the anomaly rules
 * (page header, or for one identity from the modal).
 */

import React, { useState } from 'react';
import { Alert, Button, Card, Row, Col, Space, Typography, Tag, Modal, Input, theme } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useList } from '@api/resource-hooks';
import type { IStandardUser } from '../../interfaces';
import {
  fetchRiskScores,
  fetchRiskScoresFull,
  fetchRiskScoreDistribution,
  intelligenceKeys,
  useAnalyzeAnomalies,
} from '@api/intelligence-api';
import { useQuery } from '@tanstack/react-query';
import { useSocket } from '@api/realtime';
import { getDisplayName, useRiskScoreEnrichment } from './hooks/useRiskScoreEnrichment';
import { useAnomalyData } from './hooks/useAnomalyData';
import { RiskScoreTable } from './RiskScoreTable';
import { AnomalyList } from './AnomalyList';
import { AnomalyDetailModal } from './AnomalyDetailModal';
import { analysisOutcome, type AnomalyOutcome } from './anomaly-labels';
import { usePermission } from '../../auth/usePermission';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { ErrorState } from '@shared/ErrorState';
import { KpiBand } from '@shared/KpiBand';
import { isHighRiskScore } from '@config/risk';

const { Text } = Typography;

export const RiskDashboard: React.FC = () => {
  const { token } = theme.useToken();
  const { status } = useSocket();
  const [dismissModalOpen, setDismissModalOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const isSuperAdmin = usePermission('super-admin');
  const analyze = useAnalyzeAnomalies();
  const [analysis, setAnalysis] = useState<AnomalyOutcome | null>(null);

  const { data: identityData } = useList<IStandardUser>({
    resource: 'identity',
    pagination: { pageSize: 500 },
  });

  const anomalyData = useAnomalyData();
  const {
    anomalies,
    totalAnomalies,
    allOpenAnomalies,
    totalOpenAnomalies,
    anomalyFilters,
    setAnomalyFilters,
    anomalyPage,
    setAnomalyPage,
    selectedAnomalyId,
    setSelectedAnomalyId,
    acknowledgeMutation,
    dismissMutation,
    anomaliesLoading,
    anomaliesError,
    anomaliesErrorDetail,
    refetchAnomalies,
  } = anomalyData;

  const {
    data: riskScores,
    isLoading: riskScoresLoading,
    isError: riskScoresError,
    error: riskScoresErrorDetail,
    refetch: refetchRiskScores,
  } = useQuery({
    queryKey: intelligenceKeys.riskScores(),
    queryFn: () => fetchRiskScores(50),
  });

  const { data: riskScoresFull, isLoading: riskScoresFullLoading } = useQuery({
    queryKey: intelligenceKeys.riskScoresFull({ top: 20 }),
    queryFn: () => fetchRiskScoresFull({ top: 20 }),
  });

  const { data: riskDistribution, isLoading: distributionLoading } = useQuery({
    queryKey: intelligenceKeys.riskScoreDistribution(),
    queryFn: fetchRiskScoreDistribution,
  });

  const { identityMap, enrichedRiskScores, useFullScores } = useRiskScoreEnrichment({
    identityData: identityData?.data,
    riskScores,
    riskScoresFull,
    allOpenAnomalies,
  });

  const criticalCount = allOpenAnomalies.filter((a) => a.severity === 'critical').length;
  const highRiskCount = useFullScores
    ? (riskScoresFull?.filter((r) => isHighRiskScore(r.score)).length ?? 0)
    : (riskScores?.filter((r) => isHighRiskScore(r.riskScore)).length ?? 0);
  const avgRiskScore =
    riskDistribution?.average ??
    (riskScores?.length ? riskScores.reduce((s, r) => s + r.riskScore, 0) / riskScores.length : 0);

  const loadError = anomaliesError || riskScoresError;
  const retryLoad = () => {
    void refetchAnomalies?.();
    void refetchRiskScores();
  };

  const runAnalysis = async () => {
    try {
      setAnalysis(analysisOutcome(await analyze.mutateAsync(undefined), 'batch'));
    } catch (err) {
      setAnalysis({
        type: 'error',
        message: `Analysis failed: ${apiErrorMessage(err, 'the request failed')}`,
      });
    }
  };

  const selectedRow = selectedAnomalyId
    ? (anomalies.find((a) => a.anomalyId === selectedAnomalyId) ?? null)
    : null;
  const selectedIdentity = selectedRow ? identityMap.get(selectedRow.identityId) : undefined;

  const handleDismiss = (id: string) => {
    setDismissingId(id);
    setDismissModalOpen(true);
  };

  const confirmDismiss = () => {
    if (!dismissingId) return;
    dismissMutation.mutate(
      { id: dismissingId, reason: dismissReason || undefined },
      {
        onSettled: () => {
          setDismissModalOpen(false);
          setDismissReason('');
          setDismissingId(null);
        },
      },
    );
  };

  return (
    <PageContainer>
      <PageHeader
        title="Risk dashboard"
        titleExtra={status === 'connected' ? <Tag color="success">Live</Tag> : null}
        subtitle="Monitor access anomalies and identity risk scores."
        actions={
          isSuperAdmin ? (
            <Button icon={<SearchOutlined />} loading={analyze.isPending} onClick={runAnalysis}>
              Run anomaly analysis
            </Button>
          ) : null
        }
      />

      {analysis && (
        <Alert
          showIcon
          closable
          type={analysis.type}
          message={analysis.message}
          description={analysis.description}
          onClose={() => setAnalysis(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      {loadError ? (
        <ErrorState
          title="Could not load risk data"
          error={anomaliesError ? anomaliesErrorDetail : riskScoresErrorDetail}
          onRetry={retryLoad}
        />
      ) : (
        <>
          {/* Summary */}
          <div style={{ marginBottom: 16 }}>
            <KpiBand
              loading={anomaliesLoading || (riskScoresLoading && !riskScoresFull)}
              items={[
                { key: 'open', label: 'Total open anomalies', value: totalOpenAnomalies },
                {
                  key: 'critical',
                  label: 'Critical',
                  value: criticalCount,
                  tone: criticalCount > 0 ? 'error' : 'default',
                },
                { key: 'high-risk', label: 'High-risk identities', value: highRiskCount },
                {
                  key: 'avg',
                  label: 'Avg risk score',
                  value: distributionLoading && !riskDistribution ? null : avgRiskScore,
                  decimals: 1,
                },
              ]}
            />
          </div>

          {/* Risk distribution histogram */}
          {riskDistribution && riskDistribution.buckets.length > 0 && (
            <Card title="Risk score distribution" style={{ marginBottom: 24 }}>
              <Row gutter={16} align="middle">
                <Col xs={24} md={18}>
                  <div
                    role="img"
                    aria-label={`Risk score distribution across ${riskDistribution.buckets.length} ranges`}
                  >
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart
                        data={riskDistribution.buckets.map((b) => ({
                          range: b.range,
                          count: b.count,
                        }))}
                        margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
                      >
                        <XAxis dataKey="range" />
                        <YAxis allowDecimals={false} />
                        <Tooltip
                          contentStyle={{ borderRadius: 8, fontSize: 13 }}
                          formatter={(value) => [`${value} identities`, 'Count']}
                        />
                        <Bar
                          dataKey="count"
                          fill={token.colorPrimary}
                          radius={[4, 4, 0, 0]}
                          cursor="pointer"
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Col>
                <Col xs={24} md={6}>
                  <Space direction="vertical" size={4}>
                    <Text type="secondary">Average</Text>
                    <Text strong style={{ fontSize: 20 }}>
                      {riskDistribution.average}
                    </Text>
                    <Text type="secondary">Median</Text>
                    <Text strong style={{ fontSize: 20 }}>
                      {riskDistribution.median}
                    </Text>
                  </Space>
                </Col>
              </Row>
            </Card>
          )}

          {/* Risk score table */}
          <RiskScoreTable
            enrichedRiskScores={enrichedRiskScores}
            riskScoresLoading={riskScoresLoading}
            riskScoresFullLoading={riskScoresFullLoading}
            useFullScores={useFullScores}
          />

          {/* Anomaly list */}
          <AnomalyList
            anomalies={anomalies}
            totalAnomalies={totalAnomalies}
            anomalyFilters={anomalyFilters}
            setAnomalyFilters={setAnomalyFilters}
            anomalyPage={anomalyPage}
            setAnomalyPage={setAnomalyPage}
            identityMap={identityMap}
            anomaliesLoading={anomaliesLoading}
            acknowledgeMutation={acknowledgeMutation}
            handleDismiss={handleDismiss}
            setSelectedAnomalyId={setSelectedAnomalyId}
          />
        </>
      )}

      {/* Anomaly detail modal */}
      <AnomalyDetailModal
        anomalyId={selectedAnomalyId}
        row={selectedRow}
        identityLabel={
          selectedIdentity ? getDisplayName(selectedIdentity) || selectedIdentity.email : undefined
        }
        onClose={() => setSelectedAnomalyId(null)}
      />

      {/* Dismiss Modal */}
      <Modal
        title="Dismiss anomaly"
        open={dismissModalOpen}
        onOk={confirmDismiss}
        onCancel={() => {
          setDismissModalOpen(false);
          setDismissReason('');
          setDismissingId(null);
        }}
        confirmLoading={dismissMutation.isPending}
      >
        <Input.TextArea
          placeholder="Reason (optional)"
          value={dismissReason}
          onChange={(e) => setDismissReason(e.target.value)}
          rows={3}
        />
      </Modal>
    </PageContainer>
  );
};
