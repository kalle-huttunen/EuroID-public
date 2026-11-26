/**
 * ReviewExclusionsPanel: access the identity lost in access reviews, on the Access tab. A revoke
 * at campaign close is kept as an exclusion: the policies no longer grant that entitlement (an
 * account item: anything in that system) in onboarding, the mover, a re-evaluation or the
 * preview. One row per active exclusion: system, entitlement, campaign, reviewer, justification,
 * date. A policy-admin can lift one after a confirmation (the backend route's role); the backend
 * then starts the run that gives the access back (the identity's re-evaluation; for an account,
 * onboarding, which creates it again), and the message says whether it started, and if not why.
 * Nothing is shown without exclusions (AccessTab then leaves it out, so it takes no space).
 */
import React from 'react';
import { App, Button, Space, Table, Tag, Typography } from 'antd';
import { StopOutlined, UndoOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { ErrorState } from '@shared/ErrorState';
import { useLiftReviewExclusion, useReviewExclusions } from '@api/review-exclusions-api';
import { usePermission } from '../../../auth/usePermission';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';
import type { IReviewExclusion, IReviewExclusionLift } from '../../../interfaces';

const { Text } = Typography;

const day = (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD') : '—');

/** The entitlement as an admin reads it; an account item stands for the whole system. */
const entitlementLabel = (e: IReviewExclusion) =>
  e.scope === 'account' ? `Account (all access in ${e.targetSystem})` : e.entitlementName;

/** What a lift gives back, for the confirmation message. */
const liftedAccess = (e: IReviewExclusion) =>
  e.scope === 'account'
    ? `the account in ${e.targetSystem}`
    : `${e.entitlementName} in ${e.targetSystem}`;

/** What the run a lift starts does, as the confirmation tells it. */
const comesBack = (e: IReviewExclusion) =>
  e.scope === 'account'
    ? `the identity is onboarded again now, which creates the account in ${e.targetSystem}`
    : "the identity's access is re-evaluated now, and the access comes back with that run";

/** The message after a lift: which run started, or why none did. */
function liftMessage(e: IReviewExclusion, { run }: IReviewExclusionLift): string {
  const lifted = `Exclusion lifted: ${liftedAccess(e)}.`;
  if (run.started) {
    return run.type === 'onboarding'
      ? `${lifted} Onboarding started: the account is created again.`
      : `${lifted} Re-evaluation started: the access comes back.`;
  }
  const what = run.type === 'onboarding' ? 'Onboarding' : 'The re-evaluation';
  return `${lifted} ${what} did not start: ${run.reason}`;
}

/** Cell text that wraps instead of widening the table past the screen. */
const Wrapped: React.FC<{ children: React.ReactNode; secondary?: boolean }> = ({
  children,
  secondary,
}) => (
  <Text
    type={secondary ? 'secondary' : undefined}
    style={{ display: 'block', maxWidth: 260, whiteSpace: 'normal', wordBreak: 'break-word' }}
  >
    {children}
  </Text>
);

export const ReviewExclusionsPanel: React.FC<{ identityId: string }> = ({ identityId }) => {
  const { modal, message } = App.useApp();
  // Lifting overrides what a reviewer decided: policy-admin, as the policies it gives way to
  const canLift = usePermission('policy-admin');
  const exclusions = useReviewExclusions(identityId);
  const lift = useLiftReviewExclusion(identityId);

  if (exclusions.isError) {
    return (
      <ErrorState
        compact
        title="Could not load access review exclusions"
        error={exclusions.error}
        onRetry={() => void exclusions.refetch()}
      />
    );
  }
  const rows = exclusions.data ?? [];
  if (rows.length === 0) return null;

  const confirmLift = (e: IReviewExclusion) =>
    modal.confirm({
      title: `Lift exclusion: ${entitlementLabel(e)}`,
      centered: true,
      content:
        `A reviewer revoked this access in "${e.campaignName}". After the lift the policies ` +
        `grant it again: ${comesBack(e)}. The lift is recorded in the audit log with your name.`,
      okText: 'Lift exclusion',
      onOk: async () => {
        try {
          const result = await lift.mutateAsync(e._id);
          if (result.run.started) message.success(liftMessage(e, result));
          else message.warning(liftMessage(e, result), 8);
        } catch (err) {
          message.error(`Not lifted: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });

  const columns: ColumnsType<IReviewExclusion> = [
    {
      title: 'System',
      key: 'system',
      render: (_: unknown, e) => <Tag>{e.targetSystem}</Tag>,
    },
    {
      title: 'Entitlement',
      key: 'entitlement',
      render: (_: unknown, e) => <Wrapped>{entitlementLabel(e)}</Wrapped>,
    },
    {
      title: 'Campaign',
      key: 'campaign',
      render: (_: unknown, e) => <Wrapped>{e.campaignName}</Wrapped>,
    },
    {
      title: 'Reviewer',
      key: 'reviewer',
      render: (_: unknown, e) =>
        e.decision === 'expired' ? (
          <Wrapped secondary>Not reviewed by the deadline (auto-revoked)</Wrapped>
        ) : (
          <Wrapped>{e.reviewer ?? '—'}</Wrapped>
        ),
    },
    {
      title: 'Justification',
      key: 'justification',
      render: (_: unknown, e) =>
        e.justification ? <Wrapped>{e.justification}</Wrapped> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Date',
      key: 'date',
      render: (_: unknown, e) => (
        <Text style={{ whiteSpace: 'nowrap' }}>{day(e.decidedAt ?? e.createdAt)}</Text>
      ),
    },
  ];
  if (canLift) {
    columns.push({
      title: '',
      key: 'actions',
      render: (_: unknown, e) => (
        <Button
          size="small"
          icon={<UndoOutlined />}
          aria-label={`Lift exclusion: ${entitlementLabel(e)}`}
          onClick={() => confirmLift(e)}
        >
          Lift exclusion
        </Button>
      ),
    });
  }

  return (
    <section aria-label="Revoked in access reviews">
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Text strong>
          <StopOutlined /> Revoked in access reviews
        </Text>
        <Text type="secondary">
          The policies no longer grant this access to the identity. Lifting an exclusion lets the
          next evaluation grant it again.
        </Text>
        <Table<IReviewExclusion>
          size="small"
          rowKey="_id"
          pagination={false}
          dataSource={rows}
          columns={columns}
          scroll={{ x: 'max-content' }}
        />
      </Space>
    </section>
  );
};
