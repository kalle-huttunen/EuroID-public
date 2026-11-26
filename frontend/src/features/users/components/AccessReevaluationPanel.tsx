/**
 * AccessReevaluationPanel — "Re-evaluate access" on the Access tab.
 *
 * Opens a preview first (simulate before commit): what changed in the profile since the
 * identity's access was last applied, and the entitlements a re-evaluation would add and remove
 * (GET /identity/:id/access/preview, read-only). Confirming starts the mover workflow
 * (POST /identity/:id/access/re-evaluate, operator role); its progress and result appear on the
 * Timeline tab.
 */
import React, { useState } from 'react';
import { Alert, Button, Modal, Skeleton, Space, Tag, Typography, message } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { ErrorState } from '@shared/ErrorState';
import { useAccessPreview, useReevaluateAccess } from '@api/access-change-api';
import { usePermission } from '../../../auth/usePermission';
import type { IAccessPreview, IAccessPreviewEntitlement } from '../../../interfaces';

const { Text, Paragraph } = Typography;

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function apiMessage(error: unknown): string {
  const data = (error as { response?: { data?: { message?: unknown } } })?.response?.data;
  if (typeof data?.message === 'string' && data.message) return data.message;
  return error instanceof Error ? error.message : 'Unknown error';
}

const EntitlementList: React.FC<{
  label: string;
  color: string;
  items: IAccessPreviewEntitlement[];
}> = ({ label, color, items }) =>
  items.length === 0 ? null : (
    <div>
      <Text strong>{label}</Text>
      <div style={{ marginTop: 4 }}>
        {items.map((e) => (
          <Tag
            key={`${e.type}|${e.target}|${e.targetId}`}
            color={e.appliedByMover ? color : undefined}
          >
            {e.targetId} <Text type="secondary">({e.target})</Text>
          </Tag>
        ))}
      </div>
    </div>
  );

const PreviewBody: React.FC<{ preview: IAccessPreview }> = ({ preview }) => {
  const since = preview.baselineRecordedAt
    ? new Date(preview.baselineRecordedAt).toLocaleString()
    : null;
  const notByMover = [...preview.toAdd, ...preview.toRemove].filter((e) => !e.appliedByMover);
  const nothing = preview.changes.length === 0;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {preview.blockedReason && <Alert type="info" showIcon message={preview.blockedReason} />}
      {since && nothing && (
        <Paragraph>
          Nothing changed since access was last applied ({since}). A re-evaluation would change
          nothing.
        </Paragraph>
      )}
      {since && !nothing && (
        <div>
          <Text strong>Changed since access was last applied ({since})</Text>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {preview.changes.map((c) => (
              <li key={c.field}>
                <Text code>{c.field}</Text> {displayValue(c.before)} → {displayValue(c.after)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {since && !nothing && preview.toAdd.length === 0 && preview.toRemove.length === 0 && (
        <Paragraph>The policies give the same entitlements: no access would change.</Paragraph>
      )}
      <EntitlementList label="Would add" color="green" items={preview.toAdd} />
      <EntitlementList label="Would remove" color="red" items={preview.toRemove} />
      {notByMover.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Not applied by the re-evaluation"
          description={`The mover changes groups in Entra ID, Active Directory, Okta and SCIM, and directory roles and licenses in Entra ID, nothing else. Not applied: ${notByMover
            .map((e) => `${e.targetId} (${e.target})`)
            .join(', ')}.`}
        />
      )}
    </Space>
  );
};

export const AccessReevaluationPanel: React.FC<{ identityId: string }> = ({ identityId }) => {
  const [open, setOpen] = useState(false);
  const canOperate = usePermission('operator');
  const preview = useAccessPreview(identityId, open);
  const reevaluate = useReevaluateAccess(identityId);

  const confirm = () =>
    reevaluate.mutate(undefined, {
      onSuccess: () => {
        message.success(
          'Re-evaluation started. Its progress and result appear on the Timeline tab.',
        );
        setOpen(false);
      },
      onError: (error) => {
        message.error(`Re-evaluation not started: ${apiMessage(error)}`);
      },
    });

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Text type="secondary">
          Compare the profile with the one this identity&apos;s access was last applied with.
        </Text>
        <Button icon={<SyncOutlined />} onClick={() => setOpen(true)}>
          Re-evaluate access
        </Button>
      </Space>
      <Modal
        title="Re-evaluate access"
        open={open}
        onCancel={() => setOpen(false)}
        okText="Re-evaluate access"
        onOk={confirm}
        okButtonProps={{
          disabled: !canOperate || !preview.data?.canReevaluate,
          loading: reevaluate.isPending,
          danger: (preview.data?.toRemove.length ?? 0) > 0,
        }}
        destroyOnHidden
      >
        {preview.isLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : preview.isError ? (
          <ErrorState
            compact
            title="Could not load the access preview"
            error={preview.error}
            onRetry={() => preview.refetch()}
          />
        ) : preview.data ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <PreviewBody preview={preview.data} />
            {!canOperate && (
              <Text type="secondary">Re-evaluating access requires the operator role.</Text>
            )}
          </Space>
        ) : null}
      </Modal>
    </>
  );
};
