/**
 * The answer of a hash chain check as it is: nothing to check, intact, or the first broken event
 * (or the missing end of the chain) with the reason. Under it, what the check met on the way:
 * gaps GDPR erasures recorded (not tampering) and how many events were written before hash
 * version 2, whose hash covers less.
 */
import React from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { Link } from 'react-router-dom';
import type { ChainWindow } from '@api/audit-integrity-api';
import type { IChainCheckResult } from '../../interfaces';
import {
  BREAK_REASON,
  auditLogLink,
  count,
  describeWindow,
  formatTime,
} from './audit-integrity-labels';

const { Paragraph, Text } = Typography;

/** Erasure gaps and older events among those checked; nothing when there were none. */
const CheckNotes: React.FC<{ result: IChainCheckResult }> = ({ result }) => {
  const gaps = result.erasureGaps ?? [];
  const legacy = result.legacyEventsChecked ?? 0;
  if (!gaps.length && !legacy) return null;
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {gaps.map((gap) => (
        <Paragraph key={gap.erasureEntryId} style={{ margin: 0 }} aria-label="GDPR erasure gap">
          {count(gap.eventsRemoved, 'event')} removed by the GDPR erasure{' '}
          <Text code copyable style={{ wordBreak: 'break-all' }}>
            {gap.erasureEntryId}
          </Text>{' '}
          of {formatTime(gap.erasedAt)}. Its audit entry records the positions it removed, so the
          gap is not tampering.
        </Paragraph>
      ))}
      {legacy > 0 && (
        <Paragraph type="secondary" style={{ margin: 0 }}>
          {count(legacy, 'event')} {legacy === 1 ? 'was' : 'were'} written before hash version 2.
          Their hash does not cover the payload, and their link may point to any earlier event of
          the log (each writing process kept its own last hash), so a change to a payload or a moved
          event among them is not found.
        </Paragraph>
      )}
    </Space>
  );
};

/** Events at the end of the chain are gone: there is no event after them to name. */
const MissingEnd: React.FC<{ result: IChainCheckResult; span: ChainWindow | null }> = ({
  result,
  span,
}) => (
  <Alert
    type="error"
    showIcon
    message={`The chain is broken ${describeWindow(span)}`}
    description={
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Paragraph style={{ margin: 0 }}>
          <Text strong>
            {count(result.missingEvents ?? 0, 'event')} at the end of the chain, from position{' '}
            {result.firstInvalidSeq}, {(result.missingEvents ?? 0) === 1 ? 'is' : 'are'} missing.
          </Text>{' '}
          The chain had moved past them, and no GDPR erasure recorded removing them: the newest
          events of the log were deleted. All {count(result.eventsChecked, 'event')} before them
          hold.
        </Paragraph>
        <CheckNotes result={result} />
      </Space>
    }
  />
);

export const ChainResult: React.FC<{
  result: IChainCheckResult;
  span: ChainWindow | null;
  onCheckProof: (eventId: string) => void;
}> = ({ result, span, onCheckProof }) => {
  if (result.valid && result.eventsChecked === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message={`No audit events ${describeWindow(span)}. Nothing was checked.`}
      />
    );
  }
  if (result.valid) {
    return (
      <Alert
        type="success"
        showIcon
        message={`The chain is intact: ${count(result.eventsChecked, 'event')} checked ${describeWindow(span)}.`}
        description={
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Paragraph style={{ margin: 0 }}>
              Every event hashes to its stored hash and links to the event before it, and no chain
              position is missing.
            </Paragraph>
            <CheckNotes result={result} />
          </Space>
        }
      />
    );
  }
  if (!result.firstInvalid) return <MissingEnd result={result} span={span} />;

  const reason = result.reason ? BREAK_REASON[result.reason] : undefined;
  return (
    <Alert
      type="error"
      showIcon
      message={`The chain is broken ${describeWindow(span)}`}
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Paragraph style={{ margin: 0 }}>
            First broken event:{' '}
            <Text code copyable style={{ wordBreak: 'break-all' }}>
              {result.firstInvalid}
            </Text>
            {result.firstInvalidAt && <>, written {formatTime(result.firstInvalidAt)}</>}
            {result.firstInvalidSeq !== undefined && <>, chain position {result.firstInvalidSeq}</>}
            , event {result.eventsChecked} of the window. The events after it were not checked.
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            <Text strong>{reason?.title ?? 'It does not match the chain'}.</Text>{' '}
            {result.reason === 'missing_events' && result.missingEvents !== undefined && (
              <>{count(result.missingEvents, 'position')} before it. </>
            )}
            {reason?.detail}
          </Paragraph>
          <Space wrap>
            {result.firstInvalidAt && (
              <Link to={auditLogLink(result.firstInvalidAt)}>Open it in the audit log</Link>
            )}
            <Button size="small" onClick={() => onCheckProof(result.firstInvalid as string)}>
              Check its Merkle proof
            </Button>
          </Space>
          <CheckNotes result={result} />
        </Space>
      }
    />
  );
};
