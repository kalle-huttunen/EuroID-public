/**
 * Hash chain check over a time window (GET /audit/verify-integrity, super-admin). The server
 * re-hashes every event of the window, follows the links between them and looks for missing chain
 * positions. ChainResult shows the answer as it is.
 */
import React, { useState } from 'react';
import { Alert, Button, Card, DatePicker, Select, Space, Spin, Typography } from 'antd';
import { SafetyOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { useVerifyChain, type ChainWindow } from '@api/audit-integrity-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { ChainResult } from './ChainResult';
import {
  WINDOW_CHOICES,
  WINDOW_LABEL,
  describeWindow,
  presetWindow,
  type WindowChoice,
} from './audit-integrity-labels';

const { Paragraph, Text } = Typography;

export const ChainCheckCard: React.FC<{ onCheckProof: (eventId: string) => void }> = ({
  onCheckProof,
}) => {
  const verify = useVerifyChain();
  const [choice, setChoice] = useState<WindowChoice>('day');
  const [customFrom, setCustomFrom] = useState<Dayjs | null>(null);
  const [customTo, setCustomTo] = useState<Dayjs | null>(null);
  // The window of the answer shown; the selection may have changed since.
  const [checked, setChecked] = useState<ChainWindow | null>(null);

  const customInvalid =
    choice === 'custom' && !!customFrom && !!customTo && customFrom.isAfter(customTo);

  const run = () => {
    const span: ChainWindow =
      choice === 'custom'
        ? { from: customFrom?.toISOString(), to: customTo?.toISOString() }
        : presetWindow(choice);
    setChecked(span);
    verify.mutate(span);
  };

  let result: React.ReactNode = null;
  if (verify.isPending) {
    result = (
      <Alert
        type="info"
        showIcon
        icon={<Spin size="small" />}
        message={`Checking the hash chain ${describeWindow(checked)}...`}
        description="The server reads every event of the window, oldest first. A long window can take a while; the answer appears here."
      />
    );
  } else if (verify.isError) {
    result = (
      <Alert
        type="error"
        showIcon
        message={`The check failed: ${apiErrorMessage(verify.error, 'the request failed')}`}
      />
    );
  } else if (verify.data) {
    result = <ChainResult result={verify.data} span={checked} onCheckProof={onCheckProof} />;
  }

  return (
    <Card size="small" title="Hash chain" role="region" aria-label="Hash chain">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Paragraph type="secondary" style={{ margin: 0 }}>
          Each audit event stores its position in the chain and a hash of its content and of the
          event before it. The check re-hashes every event of the window, follows the links and
          looks for missing positions; a GDPR erasure records the positions it removes. The first
          event of a window is checked by its own hash only; a window that starts earlier checks its
          link.
        </Paragraph>
        <Space wrap size="middle">
          <Select<WindowChoice>
            aria-label="Time window"
            value={choice}
            onChange={setChoice}
            options={WINDOW_CHOICES.map((c) => ({ value: c, label: WINDOW_LABEL[c] }))}
            style={{ width: 180 }}
          />
          {choice === 'custom' && (
            <>
              <DatePicker
                showTime
                placeholder="From"
                value={customFrom}
                onChange={setCustomFrom}
                status={customInvalid ? 'error' : undefined}
              />
              <DatePicker
                showTime
                placeholder="To"
                value={customTo}
                onChange={setCustomTo}
                status={customInvalid ? 'error' : undefined}
              />
            </>
          )}
          <Button
            type="primary"
            icon={<SafetyOutlined />}
            loading={verify.isPending}
            disabled={customInvalid}
            onClick={run}
          >
            Verify chain
          </Button>
        </Space>
        {customInvalid && <Text type="danger">From must be before To.</Text>}
        <div aria-live="polite">{result}</div>
      </Space>
    </Card>
  );
};
