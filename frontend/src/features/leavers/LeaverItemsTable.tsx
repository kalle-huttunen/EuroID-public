/**
 * Leaver identities (a batch's members): who, why, since when, what became of them, and what the
 * offboarding did in each target system. A policy-admin can close a failed target as removed
 * manually. OffboardingResult and IdentityCell are shared with the Failed offboardings tab.
 */
import React, { useMemo, useState } from 'react';
import { Button, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type {
  ILeaverBatchItem,
  ILeaverOffboardingResult,
  ILinkedAdminOffboardingResult,
  IOffboardingSystemResult,
} from '../../interfaces';
import { usePermission } from '../../auth/usePermission';
import { RemovedManuallyModal, type RemovedManuallyTarget } from './RemovedManuallyModal';
import {
  ADMIN_OUTCOME_LABEL,
  ADMIN_OUTCOME_TAG,
  EVENT_STATUS_LABEL,
  EVENT_STATUS_TAG,
  OUTCOME_LABEL,
  OUTCOME_TAG,
  REASON_LABEL,
  REASON_TAG,
  effectiveDateLabel,
} from './leaver-labels';
import { PAGE_SIZES } from '@config/pagination';

const { Text } = Typography;

/** Hover text: what the target did, why it failed, or who removed it by hand and how. */
function outcomeTooltip(s: IOffboardingSystemResult): string {
  if (s.outcome === 'removed-manually' && s.manualRemoval) {
    const { by, at, reason } = s.manualRemoval;
    const failure = s.reason ? ` Offboarding had failed: ${s.reason}` : '';
    return `Removed manually by ${by} on ${dayjs(at).format('YYYY-MM-DD HH:mm')}: ${reason}.${failure}`;
  }
  return s.reason ?? s.detail ?? OUTCOME_LABEL[s.outcome];
}

/** Hover text of a linked admin account: which admin identity, and why it failed or was not waited for. */
function adminTooltip(a: ILinkedAdminOffboardingResult): string {
  return `Linked admin identity ${a.identityId}${a.reason ? `: ${a.reason}` : ''}`;
}

/**
 * One tag per linked admin account and per target system (hover: what it did or why it failed)
 * and the Golden Record.
 */
export const OffboardingResult: React.FC<{
  result: ILeaverOffboardingResult;
  /** Set when the viewer may close a failed target as removed manually. */
  onCloseTarget?: (system: IOffboardingSystemResult, last: boolean) => void;
}> = ({ result, onCloseTarget }) => {
  const failedCount = result.systems.filter((s) => s.outcome === 'failed').length;
  const linkedAdmins = result.linkedAdmins ?? [];
  // A failed admin account keeps the Golden Record suspended whatever is closed here
  const adminFailed = linkedAdmins.some((a) => a.outcome === 'failed');
  return (
    <Space direction="vertical" size={4}>
      <Space size={[4, 4]} wrap>
        {linkedAdmins.map((a) => (
          <Tooltip key={a.identityId} title={adminTooltip(a)}>
            <Tag color={ADMIN_OUTCOME_TAG[a.outcome]}>
              Admin account: {ADMIN_OUTCOME_LABEL[a.outcome]}
            </Tag>
          </Tooltip>
        ))}
        {result.systems.map((s) => (
          <Space key={s.system} size={0}>
            <Tooltip title={outcomeTooltip(s)}>
              <Tag color={OUTCOME_TAG[s.outcome]}>
                {s.system}: {OUTCOME_LABEL[s.outcome]}
              </Tag>
            </Tooltip>
            {s.outcome === 'failed' && onCloseTarget && (
              <Button
                size="small"
                type="link"
                onClick={() => onCloseTarget(s, failedCount === 1 && !adminFailed)}
                aria-label={`Mark ${s.system} removed manually`}
              >
                Mark removed
              </Button>
            )}
          </Space>
        ))}
      </Space>
      <Text
        type={result.hubStatus === 'suspended' ? 'danger' : 'secondary'}
        style={{ fontSize: 12 }}
      >
        {result.hubStatus === 'deleted'
          ? 'Golden Record deleted'
          : adminFailed
            ? 'Golden Record suspended: a target or admin account may still have access'
            : 'Golden Record suspended: a target still has access'}
      </Text>
    </Space>
  );
};

/**
 * Below this width (phones) the table scrolls sideways; above it the columns keep these widths and
 * the Offboarding column takes the rest, its tags wrapping onto more lines.
 */
const LEAVER_TABLE_MIN_WIDTH = 880;

/** Name, and email below it, each cut with a tooltip in a fixed-width column. */
export const IdentityCell: React.FC<{ displayName: string; email?: string }> = ({
  displayName,
  email,
}) => (
  <div style={{ minWidth: 0 }}>
    <Text strong ellipsis={{ tooltip: displayName }} style={{ display: 'block' }}>
      {displayName}
    </Text>
    {email && (
      <Text
        type="secondary"
        ellipsis={{ tooltip: email }}
        style={{ display: 'block', fontSize: 12 }}
      >
        {email}
      </Text>
    )}
  </div>
);

const baseColumns: ColumnsType<ILeaverBatchItem> = [
  {
    title: 'Identity',
    key: 'identity',
    width: 220,
    render: (_: unknown, item) => (
      <IdentityCell displayName={item.displayName} email={item.email} />
    ),
  },
  {
    title: 'Reason',
    dataIndex: 'reason',
    key: 'reason',
    width: 150,
    render: (reason: ILeaverBatchItem['reason']) => (
      <Tag color={REASON_TAG[reason]}>{REASON_LABEL[reason]}</Tag>
    ),
  },
  {
    title: 'Since',
    key: 'effectiveDate',
    width: 170,
    render: (_: unknown, item) =>
      item.effectiveDate ? (
        <span>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {effectiveDateLabel(item.reason)}{' '}
          </Text>
          {dayjs(item.effectiveDate).format('YYYY-MM-DD')}
        </span>
      ) : (
        <Text type="secondary">Never delivered</Text>
      ),
  },
  {
    title: 'Status',
    key: 'status',
    width: 160,
    render: (_: unknown, item) => (
      <span>
        {/* Hover: why its offboarding could not start, as on the joiner page */}
        <Tooltip title={item.startError}>
          <Tag color={EVENT_STATUS_TAG[item.status]}>{EVENT_STATUS_LABEL[item.status]}</Tag>
        </Tooltip>
        {item.closeReason && item.status === 'superseded' && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {item.closeReason}
          </Text>
        )}
      </span>
    ),
  },
];

export const LeaverItemsTable: React.FC<{ items: ILeaverBatchItem[] }> = ({ items }) => {
  const canClose = usePermission('policy-admin');
  const [target, setTarget] = useState<RemovedManuallyTarget | null>(null);

  const columns = useMemo<ColumnsType<ILeaverBatchItem>>(
    () => [
      ...baseColumns,
      {
        title: 'Offboarding',
        key: 'offboarding',
        render: (_: unknown, item) => {
          const { workflowId } = item;
          return item.offboarding ? (
            <OffboardingResult
              result={item.offboarding}
              onCloseTarget={
                canClose && workflowId
                  ? (s, last) =>
                      setTarget({
                        workflowId,
                        displayName: item.displayName,
                        system: s.system,
                        failure: s.reason,
                        last,
                      })
                  : undefined
              }
            />
          ) : item.status === 'started' ? (
            <Text type="secondary">Running</Text>
          ) : (
            <Text type="secondary">-</Text>
          );
        },
      },
    ],
    [canClose],
  );

  return (
    <>
      <Table<ILeaverBatchItem>
        size="small"
        rowKey="leaverEventId"
        columns={columns}
        dataSource={items}
        pagination={items.length > PAGE_SIZES.MEDIUM ? { pageSize: PAGE_SIZES.MEDIUM } : false}
        tableLayout="fixed"
        scroll={{ x: LEAVER_TABLE_MIN_WIDTH }}
      />
      <RemovedManuallyModal target={target} onClose={() => setTarget(null)} />
    </>
  );
};
