/**
 * Peer groups (`/intelligence/peer-groups`, policy-admin like GET /intelligence/peer-groups):
 * active identities grouped by department and job title, how many deviate from their group and
 * when the group was computed. Details opens a group (PeerGroupModal): its outliers and the
 * entitlements its members hold. The nightly intelligence batch computes the
 * groups; no route computes them on demand, and nothing here changes access.
 */
import React, { useState } from 'react';
import { Button, Card, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  PEER_GROUP_PAGE_SIZE,
  accessIntelligenceKeys,
  usePeerGroups,
} from '@api/access-intelligence-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import type { IPeerGroup } from '../../interfaces';
import { PeerGroupModal } from './PeerGroupModal';
import {
  NIGHTLY_BATCH,
  formatDateTime,
  groupLabel,
  latestCalculatedAt,
} from './access-intelligence-labels';

const { Text } = Typography;

/** Below this width (phones) the groups scroll inside their card, not the page. */
const TABLE_MIN_WIDTH = 760;

export const PeerGroupsPage: React.FC = () => {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<IPeerGroup | null>(null);
  const groups = usePeerGroups(page);
  const rows = groups.data?.data ?? [];
  const lastComputed = latestCalculatedAt(rows);

  const columns: ColumnsType<IPeerGroup> = [
    {
      title: 'Group',
      key: 'group',
      render: (_: unknown, g) => (
        <span style={{ wordBreak: 'break-word' }}>{groupLabel(g.attributes)}</span>
      ),
    },
    { title: 'Members', dataIndex: 'memberCount', key: 'members', width: 100 },
    {
      title: 'Outliers',
      key: 'outliers',
      width: 100,
      render: (_: unknown, g) =>
        g.outliers.length ? <Tag color="warning">{g.outliers.length}</Tag> : <Text>0</Text>,
    },
    {
      title: 'Entitlements',
      key: 'entitlements',
      width: 120,
      render: (_: unknown, g) => g.entitlementBaseline.length,
    },
    {
      title: 'Computed',
      dataIndex: 'calculatedAt',
      key: 'calculatedAt',
      width: 150,
      render: (at: string) => formatDateTime(at),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_: unknown, g) => (
        <Button
          type="link"
          size="small"
          onClick={() => setSelected(g)}
          aria-label={`Details of ${groupLabel(g.attributes)}`}
        >
          Details
        </Button>
      ),
    },
  ];

  let body: React.ReactNode;
  if (groups.isLoading) {
    body = <Skeleton active paragraph={{ rows: 6 }} />;
  } else if (groups.isError) {
    body = (
      <ErrorState
        title="Could not load the peer groups"
        error={groups.error}
        onRetry={() => groups.refetch()}
      />
    );
  } else if (!rows.length) {
    body = (
      <EmptyState
        title="No peer groups yet"
        description={`Active identities are grouped by department and job title; a group needs at least 3 members by default (INTELLIGENCE_PEER_GROUP_MIN_SIZE). ${NIGHTLY_BATCH}`}
      />
    );
  } else {
    body = (
      <>
        {lastComputed && (
          <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            Last computed {formatDateTime(lastComputed)}. {NIGHTLY_BATCH}
          </Text>
        )}
        <Table
          aria-label="Peer groups"
          columns={columns}
          dataSource={rows}
          rowKey="groupKey"
          size="small"
          scroll={{ x: TABLE_MIN_WIDTH }}
          pagination={{
            current: page,
            pageSize: PEER_GROUP_PAGE_SIZE,
            total: groups.data?.total ?? rows.length,
            showSizeChanger: false,
            onChange: setPage,
          }}
        />
      </>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Peer groups"
        subtitle="Active identities grouped by department and job title, the entitlements each group's members hold (from the role-based rules or access requests), and the members whose access differs from their group's. Advice for reviews: nothing here grants or removes access."
        actions={
          <Button
            icon={<ReloadOutlined />}
            onClick={() =>
              qc.invalidateQueries({ queryKey: accessIntelligenceKeys.peerGroupsPrefix() })
            }
          >
            Refresh
          </Button>
        }
      />
      <Card size="small" role="region" aria-label="Peer group list" aria-busy={groups.isFetching}>
        {body}
      </Card>
      {selected && <PeerGroupModal group={selected} onClose={() => setSelected(null)} />}
    </PageContainer>
  );
};
