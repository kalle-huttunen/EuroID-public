/**
 * The confirmation content of [Run daily reconciliation]: the systems scanned and the auto-correct
 * choice. The body it sends: daily-reconciliation-body.ts.
 */
import React, { useState } from 'react';
import { Checkbox, Space, Typography } from 'antd';
import { SYSTEM_LABELS } from './daily-reconciliation-body';

const { Text } = Typography;

/** The confirmation's content: what is scanned, and the auto-correct choice (on by default). */
export const DailyRunContent: React.FC<{
  targetSystems: string[];
  onAutoCorrectChange: (autoCorrect: boolean) => void;
}> = ({ targetSystems, onAutoCorrectChange }) => {
  const [autoCorrect, setAutoCorrect] = useState(true);
  return (
    <Space direction="vertical" size="small">
      <Text>
        Scans {targetSystems.map((s) => SYSTEM_LABELS[s] ?? s).join(', ')} against the identity hub.
      </Text>
      <Checkbox
        checked={autoCorrect}
        onChange={(e) => {
          setAutoCorrect(e.target.checked);
          onAutoCorrectChange(e.target.checked);
        }}
      >
        Auto-correct missing accounts and enabled-state mismatches (a leaver&apos;s account still
        enabled is disabled)
      </Checkbox>
      <Text type="secondary">
        Without it the run only reports drifts. Deletes always wait for approval.
      </Text>
    </Space>
  );
};
