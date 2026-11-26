/**
 * HR joiner batches waiting for approval. A batch holds every joiner one HR sync would have
 * onboarded beyond the mass-joiner limit (the first import of a whole company, a broken feed); no
 * onboarding starts until an admin approves. The identity list is the impact preview; approve and
 * reject each ask for confirmation.
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
import { useDecideJoinerBatch, useJoinerBatches } from '@api/joiners-api';
import { usePermission } from '../../auth/usePermission';
import { EmptyState } from '../../components/common/EmptyState';
import type { IJoinerBatch } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { JoinerItemsTable } from './JoinerItemsTable';
import { APPROVAL_WARNING_SECONDS, approvalOutcome } from './batch-approval-outcome';
import { BATCH_STATUS_LABEL, BATCH_STATUS_TAG } from './leaver-labels';

const { Text, Paragraph } = Typography;
dayjs.extend(relativeTime);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

type Decision = { batch: IJoinerBatch; decision: 'approve' | 'reject' };

/** Joiners per department in the batch ("Engineering: 12"). */
function departmentCounts(batch: IJoinerBatch): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of batch.items) {
    const department = item.departmentName || 'No department';
    counts.set(department, (counts.get(department) ?? 0) + 1);
  }
  return [...counts.entries()];
}

function BatchCard({
  batch,
  canDecide,
  onDecide,
}: {
  batch: IJoinerBatch;
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
              {plural(batch.identityCount, 'joiner')} from <Text code>{batch.sourceName}</Text>
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
                Approve and onboard
              </Button>
            </Space>
          )}
        </Flex>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Text type="secondary">
          Found {batch.createdAt ? dayjs(batch.createdAt).fromNow() : 'recently'}. On its own this
          sync could start at most {plural(batch.allowance, 'onboarding run')} (
          {plural(batch.activeIdentityCount, 'active identity', 'active identities')}), so it
          started none.
        </Text>
        <Space size={4} wrap>
          {departmentCounts(batch).map(([department, n]) => (
            <Tag key={department}>
              {department}: {n}
            </Tag>
          ))}
        </Space>
        <JoinerItemsTable items={batch.items} />
      </Space>
    </Card>
  );
}

export const PendingJoinerBatches: React.FC = () => {
  const { message } = App.useApp();
  const { data: batches, isLoading } = useJoinerBatches('pending');
  const decide = useDecideJoinerBatch();
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
        const outcome = approvalOutcome(result, 'onboarding run');
        if (outcome.level === 'warning') {
          message.warning(outcome.text, APPROVAL_WARNING_SECONDS);
        } else {
          message.success(outcome.text);
        }
      } else {
        message.success('Batch rejected: no onboarding started');
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
        title="No joiner batches waiting"
        description="HR syncs onboard new people on their own while the pipeline is deployed and they stay within the mass-joiner limit. A sync above it pauses here."
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
        title={approving ? 'Approve joiner batch' : 'Reject joiner batch'}
        okText={
          approving ? `Onboard ${pending?.batch.identityCount ?? 0} identities` : 'Reject batch'
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
                ? `This starts the onboarding workflow for ${pending.batch.identityCount} identities from ${pending.batch.sourceName}: each gets the accounts and access the policies give it in the deployed pipeline's target systems. Each identity is read again first; anyone who has left in HR, was deleted or is already onboarded is skipped.`
                : `No identity in this batch is onboarded by the HR sync, now or later. They stay in the hub; an operator can still provision them one by one from the Users page.`}
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
