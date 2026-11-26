/**
 * The picked person's consent records (GET /identity/:id/consent), one per purpose. An operator
 * records a grant (POST, also to grant a revoked purpose again) and revokes one (DELETE, after a
 * confirmation); both reload the list and the tenant report. The backend has no route to delete
 * a record or to edit one without granting it again.
 */
import React, { useState } from 'react';
import { App, Button, Card, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { IdentityOption } from '@api/identity-api';
import { useConsents, useRevokeConsent } from '@api/gdpr-api';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import type { ConsentStatus, IConsent } from '../../interfaces';
import { CONSENT_STATUS_LABEL, CONSENT_STATUS_TAG, isPastExpiry } from './gdpr-labels';
import { GdprConsentModal } from './GdprConsentModal';

const { Text } = Typography;

/** Below this width (phones) the table scrolls sideways instead of squeezing every column. */
const CONSENT_TABLE_MIN_WIDTH = 820;

const day = (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD') : undefined);

export const GdprConsentCard: React.FC<{ identity: IdentityOption }> = ({ identity }) => {
  const { modal, message } = App.useApp();
  const canChange = usePermission('operator');
  const consents = useConsents(identity.id);
  const revoke = useRevokeConsent();
  /** The grant modal: a purpose to grant again, or empty for a new one. */
  const [grant, setGrant] = useState<{ purpose?: string } | null>(null);

  const confirmRevoke = (consent: IConsent) =>
    modal.confirm({
      title: `Revoke consent for ${consent.purpose}?`,
      content:
        'The record stays, with status revoked and today as its revocation date. Nothing else changes: EuroID removes no access and writes no audit entry for it. It can be granted again later.',
      okText: 'Revoke consent',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await revoke.mutateAsync({ identityId: identity.id, purpose: consent.purpose });
          message.success(`Consent for ${consent.purpose} revoked.`);
        } catch (err) {
          message.error(`Revoke failed: ${apiErrorMessage(err, 'the request failed')}`);
        }
      },
    });

  const columns: ColumnsType<IConsent> = [
    {
      title: 'Purpose',
      dataIndex: 'purpose',
      key: 'purpose',
      width: 200,
      ellipsis: true,
      render: (purpose: string) => <Text strong>{purpose}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 170,
      render: (status: ConsentStatus, consent) => (
        <Space size={4} wrap>
          <Tag color={CONSENT_STATUS_TAG[status]}>{CONSENT_STATUS_LABEL[status] ?? status}</Tag>
          {isPastExpiry(consent, new Date()) && <Tag color="warning">Past expiry</Tag>}
        </Space>
      ),
    },
    {
      title: 'Granted',
      key: 'granted',
      render: (_: unknown, consent) => (
        <>
          {day(consent.grantedAt)}
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            by {consent.grantedBy}
            {consent.method ? `, ${consent.method}` : ''}
          </Text>
        </>
      ),
    },
    {
      title: 'Expires',
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      width: 120,
      render: (iso?: string) => day(iso) ?? <Text type="secondary">No date</Text>,
    },
    {
      title: 'Revoked',
      dataIndex: 'revokedAt',
      key: 'revokedAt',
      width: 120,
      render: (iso: string | undefined, consent) =>
        consent.status === 'revoked' ? day(iso) : null,
    },
    ...(canChange
      ? [
          {
            title: '',
            key: 'action',
            width: 130,
            render: (_: unknown, consent: IConsent) =>
              consent.status === 'granted' ? (
                <Button
                  size="small"
                  aria-label={`Revoke ${consent.purpose}`}
                  onClick={() => confirmRevoke(consent)}
                >
                  Revoke
                </Button>
              ) : (
                <Button
                  size="small"
                  aria-label={`Grant ${consent.purpose} again`}
                  onClick={() => setGrant({ purpose: consent.purpose })}
                >
                  Grant again
                </Button>
              ),
          },
        ]
      : []),
  ];

  let body: React.ReactNode;
  if (consents.isLoading) {
    body = <Skeleton active paragraph={{ rows: 3 }} />;
  } else if (consents.isError) {
    body = (
      <ErrorState
        compact
        title="Could not load the consent records"
        error={consents.error}
        onRetry={() => consents.refetch()}
      />
    );
  } else if (!consents.data?.length) {
    body = (
      <EmptyState
        title="No consent recorded for this person"
        description="A grant recorded here is kept per purpose."
        action={canChange ? { label: 'Record consent', onClick: () => setGrant({}) } : undefined}
      />
    );
  } else {
    body = (
      <Table<IConsent>
        size="small"
        rowKey="_id"
        columns={columns}
        dataSource={consents.data}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: CONSENT_TABLE_MIN_WIDTH }}
      />
    );
  }

  return (
    <Card
      size="small"
      title="Consent (Article 6)"
      style={{ marginBottom: 16 }}
      extra={
        canChange && (
          <Button size="small" icon={<PlusOutlined />} onClick={() => setGrant({})}>
            Record consent
          </Button>
        )
      }
    >
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 12 }}>
        No other part of EuroID reads these records: they do not stop processing or provisioning,
        and grants and revokes write no audit entry. Nothing revokes a consent when its expiry date
        passes.
      </Text>
      <div role="region" aria-label="Consent records" aria-busy={consents.isFetching}>
        {body}
      </div>
      {grant && (
        <GdprConsentModal
          identity={identity}
          purpose={grant.purpose}
          onClose={() => setGrant(null)}
        />
      )}
    </Card>
  );
};
