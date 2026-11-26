/**
 * One event's Merkle proof (POST /audit/verify-event/:eventId, super-admin; the event's `_id`):
 * whether its stored hash is in a checkpoint and the proof leads to that checkpoint's root. The
 * page owns the id and the request, so the chain card can hand it a broken event.
 */
import React from 'react';
import { Alert, Button, Card, Input, Space, Typography } from 'antd';
import { NodeIndexOutlined } from '@ant-design/icons';
import type { useVerifyEvent } from '@api/audit-integrity-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { count, shortHash } from './audit-integrity-labels';

const { Paragraph, Text } = Typography;

export const EventProofCard: React.FC<{
  eventId: string;
  onEventIdChange: (eventId: string) => void;
  onCheck: () => void;
  proof: ReturnType<typeof useVerifyEvent>;
}> = ({ eventId, onEventIdChange, onCheck, proof }) => {
  const checkedId = proof.variables;
  let result: React.ReactNode = null;
  if (proof.isError) {
    result = (
      <Alert
        type="error"
        showIcon
        message={`No proof for event ${checkedId}: ${apiErrorMessage(proof.error, 'the request failed')}`}
      />
    );
  } else if (proof.data?.valid) {
    const { checkpointId, rootHash, proof: steps, legacy, legacyNote } = proof.data;
    result = (
      <Alert
        type="success"
        showIcon
        message={`Event ${checkedId} is in checkpoint ${checkpointId}`}
        description={
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Paragraph style={{ margin: 0 }}>
              Its proof ({count(steps.length, 'step')}) leads from the event&apos;s stored hash to
              the checkpoint root{' '}
              <Text code copyable={{ text: rootHash }}>
                {shortHash(rootHash)}
              </Text>
              .
            </Paragraph>
            {legacy && (
              <Paragraph style={{ margin: 0 }}>This is a legacy checkpoint. {legacyNote}</Paragraph>
            )}
            <details>
              <summary>
                <Text type="secondary">Proof steps</Text>
              </summary>
              <ol aria-label="Proof steps" style={{ margin: '8px 0 0', paddingInlineStart: 20 }}>
                {steps.map((step, i) => (
                  <li key={`${i}-${step.hash}`}>
                    <Text type="secondary">{step.position}: </Text>
                    <Text code style={{ wordBreak: 'break-all' }}>
                      {step.hash}
                    </Text>
                  </li>
                ))}
              </ol>
            </details>
          </Space>
        }
      />
    );
  } else if (proof.data) {
    result = (
      <Alert
        type="error"
        showIcon
        message={`The proof of event ${checkedId} does not lead to the root of checkpoint ${proof.data.checkpointId}`}
        description="The checkpoint no longer matches its stored event hashes: its record was changed after it was made."
      />
    );
  }

  return (
    <Card size="small" title="Single event" role="region" aria-label="Single event">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          Shows whether an event&apos;s stored hash is in a Merkle checkpoint and that its proof
          leads to the checkpoint&apos;s root. It does not re-hash the event&apos;s content; the
          chain check does.
        </Paragraph>
        <Space.Compact style={{ width: '100%', maxWidth: 520 }}>
          <Input
            aria-label="Audit event id"
            placeholder="Audit event id (its _id)"
            value={eventId}
            maxLength={100}
            onChange={(e) => onEventIdChange(e.target.value)}
            onPressEnter={() => eventId.trim() && onCheck()}
          />
          <Button
            icon={<NodeIndexOutlined />}
            loading={proof.isPending}
            disabled={!eventId.trim()}
            onClick={onCheck}
          >
            Check proof
          </Button>
        </Space.Compact>
        <div aria-live="polite">{result}</div>
      </Space>
    </Card>
  );
};
