/**
 * HR mover batches waiting for approval. A batch holds every identity one HR sync moved beyond
 * the mass-mover limit; no mover run starts until an admin approves. The identity list with each
 * HR change is the impact preview; approve and reject each ask for confirmation.
 */
import React, { useState } from 'react';
import {
  App,
  Button,
  Card,
  Flex,
  Input,
  Modal,
  Skeleton,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { CheckOutlined, CloseOutlined, PauseCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useDecideMoverBatch, useMoverBatches } from '@api/hr-movers-api';
import { usePermission } from '../../auth/usePermission';
import { EmptyState } from '../../components/common/EmptyState';
import type { IMoverBatch } from '../../interfaces';
import { MoverItemsTable } from './MoverItemsTable';
import { APPROVAL_WARNING_SECONDS, approvalOutcome } from './batch-approval-outcome';
import { BATCH_STATUS_LABEL, BATCH_STATUS_TAG } from './leaver-labels';
import { fieldLabel } from './mover-labels';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text, Paragraph } = Typography;
dayjs.extend(relativeTime);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

type Decision = { batch: IMoverBatch; decision: 'approve' | 'reject' };

function BatchCard({
  batch,
  canDecide,
  onDecide,
}: {
  batch: IMoverBatch;
  canDecide: boolean;
  onDecide: (d: Decision) => void;
}) {
  const { token } = theme.useToken();
  return (
    <Card
      style={{ borderLeft: `3px solid ${token.colorWarning}` }}
      // The decision buttons share the title row and wrap below the title on a narrow screen:
      // as the card's `extra` they squeezed the title to a few letters at 400 px.
      styles={{ title: { whiteSpace: 'normal', paddingBlock: token.paddingSM } }}
      title={
        <Flex wrap gap={8} align="center" justify="space-between">
          <Space wrap size={8}>
            <PauseCircleOutlined style={{ color: token.colorWarning }} aria-hidden />
            <span>
              {plural(batch.identityCount, 'mover')} from <Text code>{batch.sourceName}</Text>
            </span>
            <Tag color={BATCH_STATUS_TAG[batch.status]}>{BATCH_STATUS_LABEL[batch.status]}</Tag>
          </Space>
          {canDecide && (
            <Space wrap>
              <Button
                icon={<CloseOutlined />}
                onClick={() => onDecide({ batch, decision: 'reject' })}
              >
                Reject
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => onDecide({ batch, decision: 'approve' })}
              >
                Approve and move access
              </Button>
            </Space>
          )}
        </Flex>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Text type="secondary">
          Found {batch.createdAt ? dayjs(batch.createdAt).fromNow() : 'recently'}. On its own this
          sync could start at most {plural(batch.allowance, 'mover run')} (
          {plural(batch.activeIdentityCount, 'active identity', 'active identities')}), so it
          started none.
        </Text>
        <Space size={4} wrap>
          {Object.entries(batch.fieldCounts).map(([field, n]) => (
            <Tag key={field}>
              {fieldLabel(field)} changed: {n}
            </Tag>
          ))}
        </Space>
        <MoverItemsTable items={batch.items} />
      </Space>
    </Card>
  );
}

export const PendingMoverBatches: React.FC = () => {
  const { message } = App.useApp();
  const { data: batches, isLoading } = useMoverBatches('pending');
  const decide = useDecideMoverBatch();
  const canDecide = usePermission('policy-admin');
  const [pending, setPending] = useState<Decision | null>(null);
  const [comment, setComment] = useState('');

  const close = () => {
    setPending(null);
    setComment('');
  };

  const confirm = async () => {
    if (!pending) return;
    try {
      const result = await decide.mutateAsync({
        batchId: pending.batch.id,
        decision: pending.decision,
        comment: comment.trim() || undefined,
      });
      if (pending.decision === 'approve') {
        const outcome = approvalOutcome(result, 'mover run');
        if (outcome.level === 'warning') {
          message.warning(outcome.text, APPROVAL_WARNING_SECONDS);
        } else {
          message.success(outcome.text);
        }
      } else {
        message.success('Batch rejected: no mover run started');
      }
      close();
    } catch (err) {
      message.error(apiErrorMessage(err, 'Decision failed'));
    }
  };

  if (isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (!batches?.length) {
    return (
      <EmptyState
        title="No mover batches waiting"
        description="HR syncs move access on their own while they stay within the mass-mover limit. A sync above it pauses here."
      />
    );
  }

  const approving = pending?.decision === 'approve';
  return (
    <>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {batches.map((batch) => (
          <BatchCard key={batch.id} batch={batch} canDecide={canDecide} onDecide={setPending} />
        ))}
      </Space>
      <Modal
        open={!!pending}
        title={approving ? 'Approve mover batch' : 'Reject mover batch'}
        okText={
          approving
            ? `Move access for ${pending?.batch.identityCount ?? 0} identities`
            : 'Reject batch'
        }
        okButtonProps={{ danger: approving }}
        confirmLoading={decide.isPending}
        onOk={confirm}
        onCancel={close}
        destroyOnHidden
      >
        {pending && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Paragraph style={{ margin: 0 }}>
              {approving
                ? `This starts the mover workflow for ${pending.batch.identityCount} identities from ${pending.batch.sourceName}: policy groups and licenses for their old attributes are removed and those for the new ones added. Each identity is read again first; anyone whose access already matches, or who is being offboarded, is skipped.`
                : `No identity in this batch is moved. The same HR changes will not raise them again; a further change in the feed will.`}
            </Paragraph>
            <Input.TextArea
              rows={3}
              maxLength={500}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={approving ? 'Comment (optional)' : 'Reason (recommended)'}
              aria-label="Decision comment"
            />
          </Space>
        )}
      </Modal>
    </>
  );
};
