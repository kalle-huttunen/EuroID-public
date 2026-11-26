/**
 * Inventory rows as a table: the due list and the could-not-be-checked list of the credential
 * lifecycle page, and one identity's credentials on its page. The identity column links to the
 * identity's Credentials tab. Read only: nothing on these rows can be changed from the UI.
 */
import React from 'react';
import { Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useLocation } from 'react-router-dom';
import type { ICredentialRecord } from '../../interfaces';
import { identityPath } from '../users/identity-path';
import {
  STATUS_LABEL,
  STATUS_TAG,
  dueText,
  formatDate,
  formatDateTime,
  systemLabel,
} from './credential-labels';

const { Text } = Typography;

/** Below this width (phones) the table scrolls sideways instead of squeezing every column. */
const TABLE_MIN_WIDTH = 1000;

export const CredentialTable: React.FC<{
  rows: ICredentialRecord[];
  /** The identity column (lists across identities). */
  showIdentity?: boolean;
  /** The reason column (UNKNOWN rows carry one). */
  showReason?: boolean;
  /** The MFA column (Entra ID rows carry the registered methods). */
  showMfa?: boolean;
  label: string;
}> = ({ rows, showIdentity, showReason, showMfa, label }) => {
  const location = useLocation();
  const from = { from: location.pathname + location.search };

  const columns: ColumnsType<ICredentialRecord> = [
    ...(showIdentity
      ? [
          {
            title: 'Identity',
            key: 'identity',
            width: 170,
            render: (_: unknown, row: ICredentialRecord) => (
              <Link
                to={identityPath(row.identityId, 'credentials')}
                state={from}
                aria-label={`Open the credentials of identity ${row.identityId}`}
              >
                <Text code ellipsis style={{ maxWidth: '100%' }}>
                  {row.identityId}
                </Text>
              </Link>
            ),
          },
        ]
      : []),
    {
      title: 'System',
      dataIndex: 'targetSystem',
      key: 'system',
      width: 130,
      render: (system: string) => systemLabel(system),
    },
    {
      title: 'Account',
      dataIndex: 'externalId',
      key: 'account',
      ellipsis: { showTitle: false },
      render: (externalId: string) =>
        externalId ? (
          <Tooltip title={externalId}>
            <Text code>{externalId}</Text>
          </Tooltip>
        ) : (
          <Text type="secondary">None written back</Text>
        ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 170,
      render: (_: unknown, row) => {
        const status = row.password?.status ?? 'UNKNOWN';
        return <Tag color={STATUS_TAG[status]}>{STATUS_LABEL[status] ?? status}</Tag>;
      },
    },
    {
      title: 'Password changed',
      key: 'lastRotated',
      width: 140,
      render: (_: unknown, row) => formatDate(row.password?.lastRotated),
    },
    {
      title: 'Due',
      key: 'due',
      width: 160,
      render: (_: unknown, row) =>
        row.password?.nextRotation ? (
          <div>
            <div>{formatDate(row.password.nextRotation)}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {dueText(row.password.nextRotation)}
            </Text>
          </div>
        ) : (
          '—'
        ),
    },
    ...(showMfa
      ? [
          {
            title: 'MFA',
            key: 'mfa',
            width: 170,
            render: (_: unknown, row: ICredentialRecord) => {
              if (!row.mfa) return <Text type="secondary">Not read</Text>;
              if (!row.mfa.enrolled) return <Tag color="warning">Not enrolled</Tag>;
              return `Enrolled (${row.mfa.methods.join(', ')})`;
            },
          },
        ]
      : []),
    ...(showReason
      ? [
          {
            title: 'Reason',
            key: 'reason',
            render: (_: unknown, row: ICredentialRecord) => (
              <span style={{ wordBreak: 'break-word' }}>{row.password?.statusReason ?? '—'}</span>
            ),
          },
        ]
      : []),
    {
      title: 'Checked',
      dataIndex: 'observedAt',
      key: 'observedAt',
      width: 150,
      render: (iso: string | undefined) => formatDateTime(iso),
    },
  ];

  return (
    <Table<ICredentialRecord>
      size="small"
      rowKey="_id"
      aria-label={label}
      columns={columns}
      dataSource={rows}
      pagination={rows.length > 50 ? { pageSize: 50, showSizeChanger: false } : false}
      tableLayout="fixed"
      scroll={{ x: TABLE_MIN_WIDTH }}
    />
  );
};
