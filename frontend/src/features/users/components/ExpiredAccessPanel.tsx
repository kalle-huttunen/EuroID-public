/**
 * ExpiredAccessPanel: time-bound access the hourly expiry run could not remove, on the Access
 * tab. One block per provisioning entry with a failed expiry: target, expiry date, why it failed,
 * whether the run tries again. An operator can retry the removal after fixing the cause; a
 * policy-admin can also record that they removed the access in the target by hand ("removed
 * manually", never shown as removed by EuroID), the same roles as the backend routes. Nothing is
 * shown when no expired access is left (AccessTab then leaves it out, so it takes no space).
 */
import React, { useState } from 'react';
import { Alert, App, Button, Input, Modal, Space, Tag, Typography } from 'antd';
import { CheckOutlined, RedoOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { ErrorState } from '@shared/ErrorState';
import {
  useFailedExpiries,
  useMarkExpiryRemovedManually,
  useRetryExpiry,
} from '@api/expired-access-api';
import { usePermission } from '../../../auth/usePermission';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';
import type { IProvisioningEntry } from '../../../interfaces';

const { Paragraph, Text } = Typography;

const when = (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : 'unknown');

/** What the run does next with the entry. */
function nextStep(entry: IProvisioningEntry): string {
  const f = entry.expiryFailure!;
  const attempts = `${f.attempts} failed attempt${f.attempts === 1 ? '' : 's'}, last ${when(f.failedAt)}`;
  return f.retryable
    ? `Tried again automatically from ${when(f.nextAttemptAt)} (${attempts}).`
    : `Not tried again automatically (${attempts}).`;
}

const RemovedManuallyModal: React.FC<{
  identityId: string;
  entry: IProvisioningEntry | null;
  onClose: () => void;
}> = ({ identityId, entry, onClose }) => {
  const { message } = App.useApp();
  const mark = useMarkExpiryRemovedManually(identityId);
  const [reason, setReason] = useState('');

  const close = () => {
    setReason('');
    onClose();
  };

  const confirm = async () => {
    if (!entry || !reason.trim()) return;
    try {
      await mark.mutateAsync({ targetSystem: entry.targetSystem, reason: reason.trim() });
      message.success(`${entry.targetSystem} recorded as removed manually`);
      close();
    } catch (err) {
      message.error(`Not recorded: ${apiErrorMessage(err, 'the request failed')}`);
    }
  };

  return (
    <Modal
      open={!!entry}
      centered
      title={entry ? `Removed manually: ${entry.targetSystem}` : ''}
      okText="Record as removed manually"
      okButtonProps={{ disabled: !reason.trim() }}
      confirmLoading={mark.isPending}
      onOk={confirm}
      onCancel={close}
      destroyOnHidden
    >
      {entry && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Paragraph style={{ margin: 0 }}>
            The expiry run could not remove this access in <Text code>{entry.targetSystem}</Text>:{' '}
            {entry.expiryFailure?.reason}
          </Paragraph>
          <Paragraph style={{ margin: 0 }}>
            Confirm only after you have removed the access in {entry.targetSystem} yourself. It is
            recorded with your name as removed manually, not as removed by EuroID.
          </Paragraph>
          <Input.TextArea
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="How and when was the access removed? (required)"
            aria-label="Removal note"
          />
        </Space>
      )}
    </Modal>
  );
};

export const ExpiredAccessPanel: React.FC<{ identityId: string }> = ({ identityId }) => {
  const { modal, message } = App.useApp();
  const canRetry = usePermission('operator');
  // Asserts a removal EuroID cannot verify: policy-admin, as for a failed offboarding target
  const canClose = usePermission('policy-admin');
  const failed = useFailedExpiries(identityId);
  const retry = useRetryExpiry(identityId);
  const [closing, setClosing] = useState<IProvisioningEntry | null>(null);

  if (failed.isError) {
    return (
      <ErrorState
        compact
        title="Could not load expired access"
        error={failed.error}
        onRetry={() => void failed.refetch()}
      />
    );
  }
  const entries = failed.data ?? [];
  if (entries.length === 0) return null;

  const confirmRetry = (entry: IProvisioningEntry) =>
    modal.confirm({
      title: `Retry removing expired access: ${entry.targetSystem}`,
      centered: true,
      content:
        'The failure is cleared and the next hourly expiry run tries to remove the access ' +
        'again. Fix the cause first, for example the connector config or its permissions.',
      okText: 'Retry removal',
      onOk: async () => {
        try {
          await retry.mutateAsync(entry.targetSystem);
          message.success(`${entry.targetSystem}: the next expiry run tries again`);
        } catch (err) {
          message.error(`Not retried: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });

  return (
    <>
      <Alert
        type={entries.some((e) => !e.expiryFailure?.retryable) ? 'error' : 'warning'}
        showIcon
        message="Expired access not removed"
        description={
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {entries.map((entry) => (
              <div
                key={entry.targetSystem}
                role="group"
                aria-label={`Expired access in ${entry.targetSystem}`}
              >
                <Space wrap size={[8, 4]}>
                  <Tag>{entry.targetSystem}</Tag>
                  <Text type="secondary">Expired {when(entry.expiresAt)}</Text>
                </Space>
                <Paragraph style={{ margin: '4px 0' }}>{entry.expiryFailure?.reason}</Paragraph>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {nextStep(entry)}
                </Text>
                {(canRetry || canClose) && (
                  <Space wrap style={{ display: 'flex', marginTop: 8 }}>
                    {canRetry && (
                      <Button
                        size="small"
                        icon={<RedoOutlined />}
                        onClick={() => confirmRetry(entry)}
                      >
                        Retry removal
                      </Button>
                    )}
                    {canClose && (
                      <Button
                        size="small"
                        icon={<CheckOutlined />}
                        onClick={() => setClosing(entry)}
                      >
                        Mark removed manually
                      </Button>
                    )}
                  </Space>
                )}
              </div>
            ))}
          </Space>
        }
      />
      <RemovedManuallyModal
        identityId={identityId}
        entry={closing}
        onClose={() => setClosing(null)}
      />
    </>
  );
};
