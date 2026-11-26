/**
 * One peer group in a centered modal: its outliers, read again from
 * GET /intelligence/peer-groups/:groupKey/outliers (policy-admin), each linked to the person's
 * identity page (Access tab, names from GET /identity/:id), with its entitlements named as the
 * group's baseline names them (the ids are catalog native ids), and the entitlements its members
 * hold (rule-given access on a synced account, and what active access requests give them) with the
 * share holding each and how they got it. Advice only: no action here grants or removes access.
 */
import React from 'react';
import { Alert, Button, Modal, Progress, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { usePeerGroupOutliers } from '@api/access-intelligence-api';
import { useIdentity } from '@api/identity-api';
import { ErrorState } from '@shared/ErrorState';
import {
  getUserDisplayName,
  type IEntitlementBaseline,
  type IPeerGroup,
  type IPeerGroupOutlier,
} from '../../interfaces';
import { identityPath } from '../users/identity-path';
import {
  deviationColor,
  entitlementLabel,
  formatDateTime,
  formatPercent,
  grantedByLabel,
  groupLabel,
} from './access-intelligence-labels';

const { Text, Title } = Typography;

const MODAL_WIDTH = 960;
/** Below this width the tables scroll inside the modal. */
const OUTLIERS_MIN_WIDTH = 720;
const OUTLIERS_PAGE_SIZE = 10;

/** The person's name once GET /identity/:id answers, else the id; links to their access. */
const OutlierIdentity: React.FC<{ identityId: string }> = ({ identityId }) => {
  const identity = useIdentity(identityId);
  const name = identity.data ? getUserDisplayName(identity.data) : undefined;
  return (
    <Link
      to={identityPath(identityId, 'access')}
      aria-label={`Open the access of ${name ?? identityId}`}
      style={{ wordBreak: 'break-word' }}
    >
      {name ?? <Text code>{identityId}</Text>}
    </Link>
  );
};

/** The baseline's entitlement names by id: an outlier names each entitlement by its id only. */
type EntitlementNames = Map<string, string>;

/** Each entitlement as "system: name" when the group's baseline names it, else "system: id". */
const EntitlementTags: React.FC<{ ids: string[]; names: EntitlementNames; color?: string }> = ({
  ids,
  names,
  color,
}) =>
  ids.length ? (
    <Space size={[4, 4]} wrap>
      {ids.map((id) => (
        <Tag key={id} color={color} style={{ whiteSpace: 'normal' }}>
          {entitlementLabel(id, names.get(id))}
        </Tag>
      ))}
    </Space>
  ) : (
    <Text type="secondary">None</Text>
  );

const outlierColumns = (names: EntitlementNames): ColumnsType<IPeerGroupOutlier> => [
  {
    title: 'Identity',
    dataIndex: 'identityId',
    key: 'identity',
    width: 200,
    render: (id: string) => <OutlierIdentity identityId={id} />,
  },
  {
    title: 'Deviation',
    dataIndex: 'deviationScore',
    key: 'deviation',
    width: 100,
    render: (score: number) => <Tag color={deviationColor(score)}>{score}</Tag>,
  },
  {
    title: 'Has, few peers have',
    dataIndex: 'uniqueEntitlements',
    key: 'unique',
    render: (ids: string[]) => <EntitlementTags ids={ids} names={names} color="orange" />,
  },
  {
    title: 'Lacks, most peers have',
    dataIndex: 'missingBaseline',
    key: 'missing',
    render: (ids: string[]) => <EntitlementTags ids={ids} names={names} />,
  },
];

const baselineColumns: ColumnsType<IEntitlementBaseline> = [
  {
    title: 'Entitlement',
    dataIndex: 'name',
    key: 'name',
    render: (name: string) => <span style={{ wordBreak: 'break-word' }}>{name}</span>,
  },
  { title: 'System', dataIndex: 'system', key: 'system', width: 140 },
  {
    title: 'Members with it',
    dataIndex: 'holdRate',
    key: 'holdRate',
    width: 200,
    render: (rate: number) => (
      <Progress
        percent={Math.round(rate * 100)}
        size="small"
        format={() => formatPercent(rate)}
        aria-label={`${formatPercent(rate)} of the members`}
      />
    ),
  },
  {
    title: 'Held through',
    dataIndex: 'grantedBy',
    key: 'grantedBy',
    width: 170,
    render: (grantedBy: IEntitlementBaseline['grantedBy']) =>
      grantedBy?.length ? (
        grantedByLabel(grantedBy)
      ) : (
        <Text type="secondary">{grantedByLabel(grantedBy)}</Text>
      ),
  },
];

export const PeerGroupModal: React.FC<{ group: IPeerGroup; onClose: () => void }> = ({
  group,
  onClose,
}) => {
  const outliers = usePeerGroupOutliers(group.groupKey);
  const baseline = [...group.entitlementBaseline].sort((a, b) => b.holdRate - a.holdRate);
  const names: EntitlementNames = new Map(baseline.map((b) => [b.entitlementId, b.name]));

  let outlierBody: React.ReactNode;
  if (outliers.isLoading) {
    outlierBody = <Skeleton active paragraph={{ rows: 3 }} />;
  } else if (outliers.isError) {
    outlierBody = (
      <ErrorState
        compact
        title="Could not load the outliers"
        error={outliers.error}
        onRetry={() => outliers.refetch()}
      />
    );
  } else if (!outliers.data?.length) {
    outlierBody = <Text type="secondary">No member’s access differs from this group’s.</Text>;
  } else {
    outlierBody = (
      <Table
        aria-label="Outliers"
        columns={outlierColumns(names)}
        dataSource={outliers.data}
        rowKey="identityId"
        size="small"
        scroll={{ x: OUTLIERS_MIN_WIDTH }}
        pagination={
          outliers.data.length > OUTLIERS_PAGE_SIZE
            ? { pageSize: OUTLIERS_PAGE_SIZE, showSizeChanger: false }
            : false
        }
      />
    );
  }

  return (
    <Modal
      open
      centered
      onCancel={onClose}
      width={MODAL_WIDTH}
      title={<span style={{ wordBreak: 'break-word' }}>{groupLabel(group.attributes)}</span>}
      footer={<Button onClick={onClose}>Close</Button>}
      styles={{ body: { maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Text type="secondary">
          {group.memberCount} members · computed {formatDateTime(group.calculatedAt)}
        </Text>
        <Alert
          type="info"
          showIcon
          message="Advice only"
          description="Nothing here grants or removes access. Open an outlier’s identity page to see their access; an access review campaign certifies or revokes it."
        />
        <Title level={5} style={{ margin: 0 }}>
          Outliers
        </Title>
        {outlierBody}
        <Title level={5} style={{ margin: 0 }}>
          Entitlements the members hold
        </Title>
        {baseline.length ? (
          <Table
            aria-label="Group entitlements"
            columns={baselineColumns}
            dataSource={baseline}
            rowKey="entitlementId"
            size="small"
            scroll={{ x: 690 }}
            pagination={false}
          />
        ) : (
          <Text type="secondary">
            No member holds any access from the role-based rules or from access requests.
          </Text>
        )}
      </Space>
    </Modal>
  );
};
