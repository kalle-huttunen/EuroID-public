/**
 * The erasure in a centered modal. It opens with a dry run (DELETE /identity/:id/gdpr-erase
 * ?dryRun=true: the counts, nothing deleted; the backend records it in the audit log as a dry
 * run), then says what is deleted and what stays, asks for the person's identifier and erases
 * with the X-Confirm-Erasure: true header the route requires. Afterwards it shows the attestation
 * the API answered, which nothing else stores.
 */
import React, { useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Modal,
  Result,
  Skeleton,
  Space,
  Typography,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { IdentityOption } from '@api/identity-api';
import { useEraseIdentity, useErasurePreview } from '@api/gdpr-api';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import type { IErasureAttestation } from '../../interfaces';
import {
  ERASURE_KEPT,
  ERASURE_ROWS,
  LEGAL_HOLD_NOTE,
  NOT_REACHED_REMEDY,
  erasureConfirmText,
  identityLabel,
} from './gdpr-labels';

const { Paragraph, Text, Title } = Typography;

/** Room for the counts table; on narrow screens Ant Design caps it at the viewport. */
const MODAL_WIDTH = 720;

const Counts: React.FC<{ attestation: IErasureAttestation }> = ({ attestation }) => (
  <Descriptions size="small" column={1} bordered>
    {ERASURE_ROWS.map((row) => (
      <Descriptions.Item key={row.key} label={row.label}>
        {attestation.documentCounts[row.key] ?? 0}
        {row.note && (
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            {row.note}
          </Text>
        )}
      </Descriptions.Item>
    ))}
  </Descriptions>
);

/** The person's linked admin identities, erased in the same run with the same scope. */
const LinkedAdmins: React.FC<{ attestation: IErasureAttestation }> = ({ attestation }) => {
  const admins = attestation.linkedAdminIdentities ?? [];
  if (!admins.length) return null;
  const total = (counts: Record<string, number | undefined>) =>
    Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  return (
    <div>
      <Paragraph style={{ marginBottom: 4 }}>
        Linked admin identities, erased with the person with the same scope (each gets its own
        erasure entry):
      </Paragraph>
      <ul aria-label="Linked admin identities" style={{ margin: 0, paddingInlineStart: 20 }}>
        {admins.map((a) => (
          <li key={a.identityId} style={{ wordBreak: 'break-word' }}>
            <Text code>{a.identityId}</Text> {a.adminTier ?? 'admin'}: {total(a.documentCounts)}{' '}
            records
          </li>
        ))}
      </ul>
    </div>
  );
};

/** The stores the erasure could not reach, with what to do about each. */
const NotReached: React.FC<{ attestation: IErasureAttestation }> = ({ attestation }) =>
  attestation.notReached?.length ? (
    <Alert
      type="warning"
      showIcon
      message="Not reached: these may still hold the person"
      description={
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          {attestation.notReached.map((store) => (
            <li key={store}>{NOT_REACHED_REMEDY[store] ?? store}</li>
          ))}
        </ul>
      }
    />
  ) : null;

const Preview: React.FC<{ preview: IErasureAttestation }> = ({ preview }) => (
  <Space direction="vertical" size={12} style={{ width: '100%' }}>
    <Alert
      type="error"
      showIcon
      message="This cannot be undone."
      description="The records below are deleted from the database. If the person also asked for their data, download the access export first."
    />
    <Title level={5} style={{ margin: 0 }}>
      Deleted
    </Title>
    <Counts attestation={preview} />
    <LinkedAdmins attestation={preview} />
    <Title level={5} style={{ margin: 0 }}>
      Kept
    </Title>
    <ul style={{ margin: 0, paddingInlineStart: 20 }}>
      <li>
        The audit entry of this erasure (GDPR_ERASURE_EXECUTED) under identity id{' '}
        <Text code>{preview.identityId}</Text>, with your name and the counts, and the entry of each
        preview.
      </li>
      {ERASURE_KEPT.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
    <NotReached attestation={preview} />
    <Alert type="warning" showIcon message={LEGAL_HOLD_NOTE} />
  </Space>
);

const Attestation: React.FC<{ attestation: IErasureAttestation }> = ({ attestation }) => (
  <Space direction="vertical" size={12} style={{ width: '100%' }}>
    <Result
      status="success"
      title="Personal data erased"
      subTitle="This is the attestation the API answered. The audit log keeps the erasure entry with these counts, but not this attestation: keep a copy with the request."
      style={{ padding: '8px 0' }}
    />
    <Descriptions size="small" column={1} bordered>
      <Descriptions.Item label="Erased">
        {dayjs(attestation.erasedAt).format('YYYY-MM-DD HH:mm:ss')} by {attestation.erasedBy}
      </Descriptions.Item>
      <Descriptions.Item label="Identity id">
        <Text code>{attestation.identityId}</Text>
      </Descriptions.Item>
    </Descriptions>
    <NotReached attestation={attestation} />
    <Counts attestation={attestation} />
    <LinkedAdmins attestation={attestation} />
    <Text copyable={{ text: JSON.stringify(attestation, null, 2) }}>
      Copy the attestation as JSON
    </Text>
  </Space>
);

export const GdprErasureModal: React.FC<{
  identity: IdentityOption;
  /** `erased`: the erasure went through, so the person no longer exists. */
  onClose: (erased: boolean) => void;
}> = ({ identity, onClose }) => {
  // One dry run per opening, also under StrictMode (useErasurePreview)
  const preview = useErasurePreview(identity.id);
  const erase = useEraseIdentity();
  const [typed, setTyped] = useState('');
  const confirmText = erasureConfirmText(identity);

  const done = erase.isSuccess ? erase.data : undefined;
  const close = () => {
    if (!erase.isPending) onClose(!!done);
  };

  let body: React.ReactNode;
  if (done) {
    body = <Attestation attestation={done} />;
  } else if (preview.isError) {
    body = (
      <Alert
        type="error"
        showIcon
        message={`Preview failed: ${apiErrorMessage(preview.error, 'the request failed')}`}
        action={
          <Button size="small" onClick={preview.retry}>
            Retry
          </Button>
        }
      />
    );
  } else if (!preview.data) {
    body = <Skeleton active paragraph={{ rows: 8 }} />;
  } else {
    body = (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Preview preview={preview.data} />
        <div>
          <Paragraph style={{ marginBottom: 8 }}>
            Type <Text code>{confirmText}</Text> to confirm.
          </Paragraph>
          <Input
            aria-label="Identifier to confirm"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={erase.isPending}
          />
        </div>
        {erase.isError && (
          <Alert
            type="error"
            showIcon
            message={`Erasure failed: ${apiErrorMessage(erase.error, 'the request failed')}`}
            description="Some records may already be deleted: the deletes do not run in one transaction. Close this and open the erasure again to see what is left."
          />
        )}
      </Space>
    );
  }

  const footer = done ? (
    <Button type="primary" onClick={close}>
      Done
    </Button>
  ) : (
    <Space wrap style={{ justifyContent: 'flex-end' }}>
      <Button onClick={close} disabled={erase.isPending}>
        Cancel
      </Button>
      <Button
        type="primary"
        danger
        icon={<DeleteOutlined />}
        disabled={!preview.data || typed.trim() !== confirmText}
        loading={erase.isPending}
        onClick={() => erase.mutate(identity.id)}
      >
        Erase permanently
      </Button>
    </Space>
  );

  return (
    <Modal
      open
      centered
      width={MODAL_WIDTH}
      title={done ? 'Erasure done' : `Erase ${identityLabel(identity)}?`}
      footer={footer}
      onCancel={close}
      maskClosable={false}
      closable={!erase.isPending}
      keyboard={!erase.isPending}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      {body}
    </Modal>
  );
};
