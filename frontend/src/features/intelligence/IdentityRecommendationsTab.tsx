/**
 * The identity page's Recommendations tab (operator, like GET
 * /intelligence/recommendations/:identityId): entitlements most of the identity's peer group
 * (same department and job title) holds and this identity does not, with the share of peers
 * holding each, how they hold it (role-based rules or access requests), whether the catalog offers
 * it for request and the catalog's risk level. Advice only: nothing here grants access. The answer
 * carries no computation time, so the tab cannot say when it was computed.
 */
import React from 'react';
import { Progress, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useRecommendations } from '@api/access-intelligence-api';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import type { IAccessRecommendation, PeerGrantedBy } from '../../interfaces';
import {
  NIGHTLY_BATCH,
  RISK_COLOR,
  formatPercent,
  grantedByLabel,
} from './access-intelligence-labels';

const { Text } = Typography;

/** Below this width (phones) the table scrolls inside the tab, not the page. */
const TABLE_MIN_WIDTH = 900;

const columns: ColumnsType<IAccessRecommendation> = [
  {
    title: 'Entitlement',
    dataIndex: 'name',
    key: 'name',
    render: (name: string) => <span style={{ wordBreak: 'break-word' }}>{name}</span>,
  },
  { title: 'System', dataIndex: 'system', key: 'system', width: 140 },
  {
    title: 'Peers with it',
    dataIndex: 'holdRate',
    key: 'holdRate',
    width: 200,
    render: (rate: number) => (
      <Progress
        percent={Math.round(rate * 100)}
        size="small"
        format={() => formatPercent(rate)}
        aria-label={`${formatPercent(rate)} of the peers`}
      />
    ),
  },
  {
    title: 'Peers have it through',
    dataIndex: 'grantedBy',
    key: 'grantedBy',
    width: 170,
    render: (grantedBy: PeerGrantedBy[]) =>
      grantedBy?.length ? (
        grantedByLabel(grantedBy)
      ) : (
        <Text type="secondary">{grantedByLabel(grantedBy)}</Text>
      ),
  },
  {
    title: 'Request',
    dataIndex: 'requestable',
    key: 'requestable',
    width: 140,
    render: (requestable: boolean) =>
      requestable ? (
        <Tag color="success">Requestable</Tag>
      ) : (
        <Text type="secondary">Not requestable</Text>
      ),
  },
  {
    title: 'Risk',
    dataIndex: 'riskLevel',
    key: 'riskLevel',
    width: 140,
    render: (level?: string) =>
      level ? (
        <Tag color={RISK_COLOR[level] ?? 'default'}>{level}</Tag>
      ) : (
        <Text type="secondary">Not in the catalog</Text>
      ),
  },
];

export const IdentityRecommendationsTab: React.FC<{ identityId: string }> = ({ identityId }) => {
  const recommendations = useRecommendations(identityId);

  if (recommendations.isLoading) return <Skeleton active paragraph={{ rows: 4 }} />;
  if (recommendations.isError) {
    return (
      <ErrorState
        title="Could not load the recommendations"
        error={recommendations.error}
        onRetry={() => recommendations.refetch()}
      />
    );
  }
  const rows = recommendations.data ?? [];
  if (!rows.length) {
    return (
      <EmptyState
        title="No recommendations for this identity"
        description={`It already has what most of its peer group has, or it is in no peer group: active identities are grouped by department and job title, at least 3 to a group by default. ${NIGHTLY_BATCH}`}
      />
    );
  }
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Text type="secondary">
        Most of this identity’s peers (same department and job title) have these, from the
        role-based rules or from access requests, and this identity does not. A requestable one is
        in the access request catalog. Advice only: nothing here grants access. {NIGHTLY_BATCH}
      </Text>
      <Table
        aria-label="Recommended entitlements"
        columns={columns}
        dataSource={rows}
        rowKey="entitlementId"
        size="small"
        scroll={{ x: TABLE_MIN_WIDTH }}
        pagination={false}
      />
    </Space>
  );
};
