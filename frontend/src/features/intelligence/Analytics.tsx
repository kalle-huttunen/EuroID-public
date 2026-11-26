/**
 * Analytics — Intelligence Layer
 *
 * Upcoming offboardings, license forecast, seasonal patterns.
 */

import React, { useState } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Typography,
  Tag,
  Modal,
  Row,
  Col,
  Skeleton,
  message,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowUpOutlined, ArrowDownOutlined, MinusOutlined } from '@ant-design/icons';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchUpcomingOffboardings,
  fetchUpcomingOffboardingByIdentity,
  fetchLicenseForecast,
  fetchSeasonalPatterns,
  intelligenceKeys,
  type UpcomingOffboarding,
  type LicenseForecast,
  type SeasonalPattern,
} from '@api/intelligence-api';
import { useSocket } from '@api/realtime';
import { EmptyState } from '../../components/common/EmptyState';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { ErrorState } from '@shared/ErrorState';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text } = Typography;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function getDaysRemainingColor(days: number): string {
  if (days < 7) return 'red';
  if (days < 30) return 'orange';
  return 'green';
}

export const Analytics: React.FC = () => {
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const { status } = useSocket();
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);

  const offboardingsQuery = useQuery({
    queryKey: intelligenceKeys.upcomingOffboardings(30),
    queryFn: () => fetchUpcomingOffboardings(30, false),
  });
  const { data: offboardings, isLoading: offboardingsLoading } = offboardingsQuery;

  const refreshMutation = useMutation({
    mutationFn: () => fetchUpcomingOffboardings(30, true),
    onSuccess: (data) => {
      queryClient.setQueryData(intelligenceKeys.upcomingOffboardings(30), data);
      message.success('Offboardings refreshed');
    },
    // Not returned: React Query would keep the mutation pending until the toast closes
    onError: (e: Error) => {
      message.error('Refresh failed: ' + apiErrorMessage(e, e.message));
    },
  });

  const { data: selectedOffboarding, isLoading: selectedLoading } = useQuery({
    queryKey: intelligenceKeys.offboardingByIdentity(selectedIdentityId!),
    queryFn: () => fetchUpcomingOffboardingByIdentity(selectedIdentityId!),
    enabled: !!selectedIdentityId,
  });

  const licenseQuery = useQuery({
    queryKey: intelligenceKeys.licenseForecast(90),
    queryFn: () => fetchLicenseForecast(90),
  });
  const { data: licenseForecast, isLoading: licenseLoading } = licenseQuery;

  const seasonalQuery = useQuery({
    queryKey: intelligenceKeys.seasonalPatterns(),
    queryFn: fetchSeasonalPatterns,
  });
  const { data: seasonalPatterns, isLoading: seasonalLoading } = seasonalQuery;

  const offboardingsList = offboardings ?? [];
  const licenseList = licenseForecast ?? [];
  const seasonalList = seasonalPatterns ?? [];

  const offboardingColumns: ColumnsType<UpcomingOffboarding> = [
    { title: 'Name', dataIndex: 'displayName', key: 'displayName' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    {
      title: 'End Date',
      dataIndex: 'endDate',
      key: 'endDate',
      render: (d: string) => new Date(d).toLocaleDateString(),
    },
    {
      title: 'Days Remaining',
      dataIndex: 'daysRemaining',
      key: 'daysRemaining',
      render: (d: number) => <Tag color={getDaysRemainingColor(d)}>{d}</Tag>,
    },
    {
      title: 'Affected Systems',
      key: 'affectedSystems',
      render: (_, r) =>
        r.blastRadius?.affectedSystems?.length ? (
          <Space wrap size={4}>
            {r.blastRadius.affectedSystems.map((s) => (
              <Tag key={s}>{s}</Tag>
            ))}
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: 'Entitlements',
      key: 'entitlements',
      render: (_, r) => r.blastRadius?.totalEntitlements ?? '—',
    },
    {
      title: '',
      key: 'view',
      render: (_, r) => (
        <Button type="link" size="small" onClick={() => setSelectedIdentityId(r.identityId)}>
          View detail
        </Button>
      ),
    },
  ];

  const chartData = seasonalList.map((s) => ({
    name: `${MONTH_NAMES[s.month - 1]} ${s.year}`,
    value: s.peakOnboardings,
    fullMark: s.averageOnboardings,
    isAnomalous: s.isAnomalous,
  }));

  return (
    <PageContainer>
      <PageHeader
        title="Analytics"
        titleExtra={status === 'connected' ? <Tag color="success">Live</Tag> : null}
        subtitle="Predicted offboardings, license forecast and seasonal access patterns."
      />

      {/* Upcoming Offboardings */}
      <Card
        title="Upcoming offboardings"
        extra={
          <Button
            size="small"
            onClick={() => refreshMutation.mutate()}
            loading={refreshMutation.isPending}
          >
            Refresh
          </Button>
        }
        style={{ marginBottom: 24 }}
      >
        {offboardingsLoading ? (
          <Skeleton active />
        ) : offboardingsQuery.isError ? (
          <ErrorState
            compact
            title="Upcoming offboardings could not be loaded"
            error={offboardingsQuery.error}
            onRetry={() => void offboardingsQuery.refetch()}
          />
        ) : offboardingsList.length === 0 ? (
          <EmptyState
            title="No upcoming offboardings"
            description="No departures scheduled in the next 30 days."
          />
        ) : (
          <Table
            columns={offboardingColumns}
            dataSource={offboardingsList}
            rowKey="identityId"
            pagination={false}
            size="small"
            virtual
            scroll={{ y: 480, x: 800 }}
            onRow={(r) => ({
              style: { cursor: 'pointer' },
              onClick: () => setSelectedIdentityId(r.identityId),
            })}
          />
        )}
      </Card>

      {/* Blast radius detail: read-only, opened from an offboarding row */}
      <Modal
        title="Blast radius detail"
        open={!!selectedIdentityId}
        onCancel={() => setSelectedIdentityId(null)}
        footer={null}
        width={560}
        styles={{ body: { maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' } }}
      >
        {selectedLoading ? (
          <Skeleton active />
        ) : selectedOffboarding ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Text type="secondary">Identity</Text>
              <div>
                <Text strong>{selectedOffboarding.displayName}</Text>
                <br />
                <Text type="secondary">{selectedOffboarding.email}</Text>
              </div>
            </div>
            <div>
              <Text type="secondary">End Date</Text>
              <div>{new Date(selectedOffboarding.endDate).toLocaleDateString()}</div>
            </div>
            <div>
              <Text type="secondary">Days Remaining</Text>
              <div>
                <Tag color={getDaysRemainingColor(selectedOffboarding.daysRemaining)}>
                  {selectedOffboarding.daysRemaining}
                </Tag>
              </div>
            </div>
            <div>
              <Text type="secondary">Affected Systems</Text>
              <div>
                <Space wrap>
                  {selectedOffboarding.blastRadius?.affectedSystems?.map((s) => (
                    <Tag key={s}>{s}</Tag>
                  )) ?? '—'}
                </Space>
              </div>
            </div>
            <div>
              <Text type="secondary">
                Entitlements ({selectedOffboarding.blastRadius?.totalEntitlements ?? 0})
              </Text>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {selectedOffboarding.blastRadius?.entitlements?.map((e, i) => (
                  <li key={i}>
                    {e.system}: {e.name} ({e.type})
                  </li>
                ))}
              </ul>
            </div>
          </Space>
        ) : null}
      </Modal>

      {/* License Forecast */}
      <Card title="License forecast" style={{ marginBottom: 24 }}>
        {licenseLoading ? (
          <Skeleton active />
        ) : licenseQuery.isError ? (
          <ErrorState
            compact
            title="License forecast could not be loaded"
            error={licenseQuery.error}
            onRetry={() => void licenseQuery.refetch()}
          />
        ) : licenseList.length === 0 ? (
          <EmptyState
            title="No license data"
            description="License tracking will appear once connectors report usage."
          />
        ) : (
          <Row gutter={[16, 16]}>
            {licenseList.map((l) => (
              <Col xs={24} sm={12} md={8} lg={6} key={`${l.system}-${l.license}`}>
                <Card size="small">
                  <Space direction="vertical" size={0}>
                    <Text strong>
                      {l.system}: {l.license}
                    </Text>
                    <Text type="secondary">
                      {l.currentCount === null
                        ? 'Current: unknown (discovery has not run)'
                        : `Current: ${l.currentCount}${l.capacity !== null ? ` of ${l.capacity}` : ''}`}
                    </Text>
                    <Text type="secondary">
                      Projected (90d): {l.projectedCount === null ? 'unknown' : l.projectedCount}
                    </Text>
                    {l.daysToCapacity != null && (
                      <Tag color="orange">Days to capacity: {l.daysToCapacity}</Tag>
                    )}
                    <Space>
                      {l.trend === 'growing' && (
                        <ArrowUpOutlined style={{ color: token.colorSuccess }} />
                      )}
                      {l.trend === 'declining' && (
                        <ArrowDownOutlined style={{ color: token.colorError }} />
                      )}
                      {l.trend === 'stable' && (
                        <MinusOutlined style={{ color: token.colorTextTertiary }} />
                      )}
                      <Text type="secondary">{l.trend}</Text>
                    </Space>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      {/* Seasonal Patterns */}
      <Card title="Seasonal patterns">
        {seasonalLoading ? (
          <Skeleton active />
        ) : seasonalQuery.isError ? (
          <ErrorState
            compact
            title="Seasonal patterns could not be loaded"
            error={seasonalQuery.error}
            onRetry={() => void seasonalQuery.refetch()}
          />
        ) : seasonalList.length === 0 ? (
          <EmptyState
            title="No seasonal data yet"
            description="Patterns will emerge after a few months of onboarding data."
          />
        ) : (
          <div
            style={{ height: 300 }}
            role="img"
            aria-label={`Seasonal onboarding patterns across ${chartData.length} months`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip
                  contentStyle={{ borderRadius: 8, fontSize: 13 }}
                  formatter={(value) => [`${value} onboardings`, 'Peak']}
                />
                <Bar
                  dataKey="value"
                  fill={token.colorPrimary}
                  radius={[4, 4, 0, 0]}
                  name="Onboardings"
                  cursor="pointer"
                />
              </BarChart>
            </ResponsiveContainer>
            {seasonalList.some((s) => s.isAnomalous) && (
              <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
                Highlighted months indicate anomalous volume.
              </Text>
            )}
          </div>
        )}
      </Card>
    </PageContainer>
  );
};
