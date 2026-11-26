/**
 * Leaver batches waiting for approval. A batch holds every leaver of one HR sync that exceeded
 * the mass-leaver limit; none of them is offboarded until an admin approves. The identity list
 * is the impact preview; approve and reject each ask for confirmation.
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
import { useDecideLeaverBatch, useLeaverBatches } from '@api/leavers-api';
import { usePermission } from '../../auth/usePermission';
import { EmptyState } from '../../components/common/EmptyState';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { ILeaverBatch, LeaverReason } from '../../interfaces';
import { LeaverItemsTable } from './LeaverItemsTable';
import { APPROVAL_WARNING_SECONDS, approvalOutcome } from './batch-approval-outcome';
import { BATCH_STATUS_LABEL, BATCH_STATUS_TAG, REASON_LABEL, REASON_TAG } from './leaver-labels';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';

const { Text, Paragraph } = Typography;
dayjs.extend(relativeTime);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

type Decision = { batch: ILeaverBatch; decision: 'approve' | 'reject' };

function ReasonSummary({ counts }: { counts: ILeaverBatch['reasonCounts'] }) {
  const entries = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0) as Array<
    [LeaverReason, number]
  >;
  return (
    <Space size={4} wrap>
      {entries.map(([reason, n]) => (
        <Tag key={reason} color={REASON_TAG[reason]}>
          {REASON_LABEL[reason]}: {n}
        </Tag>
      ))}
    </Space>
  );
}

function BatchCard({
  batch,
  canDecide,
  onDecide,
}: {
  batch: ILeaverBatch;
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
              {batch.identityCount} leavers from <Text code>{batch.sourceName}</Text>
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
                danger
                icon={<CheckOutlined />}
                onClick={() => onDecide({ batch, decision: 'approve' })}
              >
                Approve and offboard
              </Button>
            </Space>
          )}
        </Flex>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Text type="secondary">
          Found {batch.createdAt ? dayjs(batch.createdAt).fromNow() : 'recently'}. On its own this
          sync could start at most {plural(batch.allowance, 'offboarding')} (
          {plural(batch.activeIdentityCount, 'active identity', 'active identities')}), so it
          started none.
        </Text>
        <ReasonSummary counts={batch.reasonCounts} />
        <LeaverItemsTable items={batch.items} />
      </Space>
    </Card>
  );
}

export const PendingLeaverBatches: React.FC = () => {
  const { message } = App.useApp();
  const { data: batches, isLoading } = useLeaverBatches('pending');
  const decide = useDecideLeaverBatch();
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
        const outcome = approvalOutcome(result, 'offboarding');
        if (outcome.level === 'warning') {
          message.warning(outcome.text, APPROVAL_WARNING_SECONDS);
        } else {
          message.success(outcome.text);
        }
      } else {
        message.success('Batch rejected: no offboarding started');
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
        title="No leaver batches waiting"
        description="HR syncs offboard their leavers on their own while they stay within the mass-leaver limit. A sync above it pauses here."
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
        title={approving ? 'Approve leaver batch' : 'Reject leaver batch'}
        okText={
          approving ? `Offboard ${pending?.batch.identityCount ?? 0} identities` : 'Reject batch'
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
                ? `This starts the offboarding workflow for ${pending.batch.identityCount} identities from ${pending.batch.sourceName}: their accounts in connected systems are disabled or deleted. Anyone back in the feed since is skipped.`
                : `No identity in this batch is offboarded. The same HR data will not raise them again; a change in the feed will.`}
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
