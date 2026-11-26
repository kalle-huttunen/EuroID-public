/**
 * Merkle checkpoints (GET /audit/merkle-roots, super-admin), newest first, with the chain
 * positions they cover (a legacy checkpoint over the events written before hash version 2 is
 * marked so) and their anchor status; a signed checkpoint opens its anchor proof.
 * "Create checkpoint" (POST /audit/merkle-roots) makes one over the events since the last one;
 * "Check checkpoints" (POST /audit/verify) checks them against the events they cover.
 */
import React, { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Grid,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApartmentOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons';
import {
  CHECKPOINTS_PAGE_SIZE,
  useCheckRoots,
  useCheckpoints,
  useCreateCheckpoint,
} from '@api/audit-integrity-api';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import type { IMerkleCheckpoint } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { count, formatTime, shortHash } from './audit-integrity-labels';
import { CheckpointCheckResult } from './CheckpointCheckResult';

const { Text } = Typography;

/** Below this width (phones) the table scrolls sideways instead of squeezing every column. */
const CHECKPOINTS_TABLE_MIN_WIDTH = 1190;

const NOT_SIGNED = 'Not signed: no anchor key was configured when this checkpoint was made.';

const LEGACY =
  'Events written before hash version 2, in time order: they have no chain positions, and their hash does not cover the payload. The daily audit archive run made this checkpoint once.';

export const CheckpointsCard: React.FC<{
  onOpenAnchor: (checkpoint: IMerkleCheckpoint) => void;
}> = ({ onOpenAnchor }) => {
  const { modal, message } = App.useApp();
  const [page, setPage] = useState(1);
  const list = useCheckpoints(page);
  // Below 576 px the header has no room for the title and the buttons: they open the body
  const stacked = !Grid.useBreakpoint().sm;
  const roots = useCheckRoots();
  const create = useCreateCheckpoint();

  const confirmCreate = () =>
    modal.confirm({
      title: 'Create a Merkle checkpoint now?',
      content:
        'It covers the audit events written since the last checkpoint (events written before hash version 2 are in the legacy checkpoints of the daily audit archive run) and is signed when an anchor key is configured. A checkpoint stays: the page cannot delete it. The audit log records that you made it.',
      okText: 'Create checkpoint',
      onOk: async () => {
        try {
          const made = await create.mutateAsync();
          message.success(`Checkpoint created over ${count(made.eventCount, 'event')}.`);
        } catch (err) {
          message.error(`No checkpoint was created: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });

  const columns: ColumnsType<IMerkleCheckpoint> = [
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 150,
      render: (iso: string) => formatTime(iso, false),
    },
    { title: 'Events', dataIndex: 'eventCount', key: 'eventCount', width: 90, align: 'right' },
    {
      title: 'Positions',
      key: 'positions',
      width: 120,
      render: (_: unknown, cp) =>
        cp.legacy ? (
          <Tooltip title={LEGACY}>
            <Tag>Legacy, part {cp.legacyPart ?? 1}</Tag>
          </Tooltip>
        ) : cp.firstSeq !== undefined && cp.lastSeq !== undefined ? (
          `${cp.firstSeq} to ${cp.lastSeq}`
        ) : (
          <Tooltip title="Made before audit events had chain positions">
            <Text type="secondary">Not recorded</Text>
          </Tooltip>
        ),
    },
    {
      title: 'Covers',
      key: 'covers',
      width: 280,
      render: (_: unknown, cp) =>
        `${formatTime(cp.firstEventTimestamp, false)} to ${formatTime(cp.lastEventTimestamp, false)}`,
    },
    {
      title: 'Root hash',
      dataIndex: 'rootHash',
      key: 'rootHash',
      width: 200,
      render: (hash: string) => (
        <Tooltip title={hash}>
          <Text code copyable={{ text: hash }}>
            {shortHash(hash)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'Anchor',
      key: 'anchor',
      width: 220,
      render: (_: unknown, cp) =>
        cp.anchorSignature ? (
          <Space size={4} wrap>
            <Tag color="success">Signed</Tag>
            {cp.anchoredAt && <Text type="secondary">{formatTime(cp.anchoredAt, false)}</Text>}
            {cp.externalAnchor && (
              <Tag>Witness {cp.externalAnchor.responseStatus ?? 'delivered'}</Tag>
            )}
          </Space>
        ) : (
          <Tag>Not signed</Tag>
        ),
    },
    {
      title: '',
      key: 'open',
      width: 130,
      render: (_: unknown, cp) => (
        <Tooltip title={cp.anchorSignature ? undefined : NOT_SIGNED}>
          <Button
            size="small"
            icon={<KeyOutlined />}
            disabled={!cp.anchorSignature}
            onClick={() => onOpenAnchor(cp)}
            aria-label={`Anchor proof of checkpoint ${cp.checkpointId}`}
          >
            Anchor proof
          </Button>
        </Tooltip>
      ),
    },
  ];

  const items = list.data?.data ?? [];
  let body: React.ReactNode;
  if (list.isLoading) {
    body = <Skeleton active paragraph={{ rows: 4 }} />;
  } else if (list.isError) {
    body = (
      <ErrorState
        title="Could not load the checkpoints"
        error={list.error}
        onRetry={() => list.refetch()}
        compact
      />
    );
  } else if (!items.length) {
    body = (
      <EmptyState
        title="No Merkle checkpoints yet"
        description="The daily audit archive run makes them when it is enabled, and Create checkpoint makes one now. Event proofs and anchors need one."
      />
    );
  } else {
    body = (
      <Table<IMerkleCheckpoint>
        size="small"
        rowKey="_id"
        columns={columns}
        dataSource={items}
        tableLayout="fixed"
        scroll={{ x: CHECKPOINTS_TABLE_MIN_WIDTH }}
        pagination={{
          current: page,
          pageSize: CHECKPOINTS_PAGE_SIZE,
          total: list.data?.total ?? 0,
          showSizeChanger: false,
          hideOnSinglePage: true,
          onChange: setPage,
        }}
      />
    );
  }

  const actions = (
    <Space size={8} wrap>
      <Button
        size="small"
        icon={<PlusOutlined />}
        loading={create.isPending}
        onClick={confirmCreate}
      >
        Create checkpoint
      </Button>
      <Button
        size="small"
        icon={<ApartmentOutlined />}
        loading={roots.isPending}
        onClick={() => roots.mutate()}
      >
        Check checkpoints
      </Button>
    </Space>
  );

  return (
    <Card
      size="small"
      title="Merkle checkpoints"
      role="region"
      aria-label="Merkle checkpoints"
      aria-busy={list.isFetching}
      extra={stacked ? undefined : actions}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {stacked && actions}
        {roots.isError && (
          <Alert
            type="error"
            showIcon
            closable
            onClose={() => roots.reset()}
            message={`The checkpoint check failed: ${apiErrorMessage(roots.error, 'the request failed')}`}
          />
        )}
        {roots.data && <CheckpointCheckResult result={roots.data} onClose={() => roots.reset()} />}
        {body}
      </Space>
    </Card>
  );
};
