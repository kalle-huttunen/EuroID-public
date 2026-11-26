/**
 * The answer of "Check checkpoints" (POST /audit/verify): every stored root against its stored
 * event hashes, and the covered events still in the log re-hashed against them. Names the first
 * checkpoint that fails and why; counts covered events that left the log without judging them,
 * and the legacy checkpoints with what their check proves.
 */
import React from 'react';
import { Alert, Typography } from 'antd';
import type { IRootsCheckResult } from '../../interfaces';
import { count } from './audit-integrity-labels';

const { Text } = Typography;

export const CheckpointCheckResult: React.FC<{
  result: IRootsCheckResult;
  onClose: () => void;
}> = ({ result, onClose }) => {
  const alert = { showIcon: true, closable: true, onClose } as const;
  if (result.checkpointsVerified === 0) {
    return <Alert type="info" {...alert} message="No checkpoints to check." />;
  }
  if (result.valid) {
    const missing = result.eventsMissing ?? 0;
    const legacy = result.legacyCheckpointsChecked ?? 0;
    return (
      <Alert
        type="success"
        {...alert}
        message={`${count(result.checkpointsVerified, 'checkpoint')} checked: every stored root matches its event hashes, and ${count(result.eventsVerified, 'covered event')} re-hash to them.`}
        description={
          <>
            {missing > 0
              ? `${count(missing, 'covered event')} ${missing === 1 ? 'is' : 'are'} no longer in the log: removed by retention, a GDPR erasure or a deletion. The hash chain check tells a recorded erasure from a deletion.`
              : 'Every covered event is still in the log.'}
            {legacy > 0 && (
              <span style={{ display: 'block', marginTop: 4 }}>
                {`${legacy} of them ${legacy === 1 ? 'is a legacy checkpoint' : 'are legacy checkpoints'}. ${result.legacyNote ?? ''}`}
              </span>
            )}
          </>
        }
      />
    );
  }
  if (result.reason === 'event_changed') {
    return (
      <Alert
        type="error"
        {...alert}
        message={`An event that checkpoint ${result.firstInvalidCheckpoint} covers was changed after the checkpoint`}
        description={
          <>
            Event{' '}
            <Text code copyable style={{ wordBreak: 'break-all' }}>
              {result.invalidEventId}
            </Text>{' '}
            is no longer what the checkpoint recorded: its content or its stored hash changed.
          </>
        }
      />
    );
  }
  return (
    <Alert
      type="error"
      {...alert}
      message={`Checkpoint ${result.firstInvalidCheckpoint ?? ''}: its stored root does not match its stored event hashes`}
      description="The checkpoint record was changed after it was made. If it was signed, its anchor proof no longer verifies, and its events' proofs fail."
    />
  );
};
