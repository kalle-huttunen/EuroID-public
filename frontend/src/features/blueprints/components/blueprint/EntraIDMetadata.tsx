/**
 * EntraIDMetadata - Entra ID Specific Pre-Flight Validation
 *
 * What provisioning to Microsoft Entra ID would do for each person, as the impact analysis
 * derives it:
 *
 * 1. Licenses the policy assigns, with the units left when Entra ID discovery has read them
 * 2. Groups and directory roles the policy assigns, each in its own column, by their entitlement
 *    catalog name
 * 3. UPN Validation: Checks userPrincipalName conflicts and domain validation; a UPN the API does
 *    not know (no Entra ID config with a default domain) is shown as not known
 * 4. What the preview does not know (the UPN, conditional access, entitlements not discovered)
 */

import React from 'react';
import type { IEntraUserMetadata } from '../../../../interfaces/impact-analysis.interface';
import { Card, Table, Tag, Space, Typography, Alert, Divider, Tooltip, theme } from 'antd';
import {
  SafetyCertificateOutlined,
  MailOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  QuestionCircleOutlined,
  SafetyOutlined,
  CrownOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

export interface EntraUserMetadata {
  userId: string;
  displayName: string;
  /** Null when the preview does not know it. */
  upn: string | null;
  upnStatus: 'valid' | 'conflict' | 'unknown';
  upnIssue?: string;
  /** Suggested alternative UPN when primary is taken */
  suggestedUpn?: string;
  /** All candidates that were checked */
  candidatesChecked?: string[];
  licenses: {
    sku: string;
    name: string;
    assigned: boolean;
    /** Units left; null until Entra ID discovery has read the license. */
    available: number | null;
  }[];
  /** The groups the policy assigns, by their catalog name. */
  groups: string[];
  /** The directory roles the policy assigns, by their catalog name. */
  roles: string[];
  /** What the preview cannot tell. */
  notKnown: string[];
  department?: string;
  location?: string;
}

interface Props {
  users: EntraUserMetadata[] | IEntraUserMetadata[];
  loading?: boolean;
}

export const EntraIDMetadata: React.FC<Props> = ({ users, loading = false }) => {
  const { token } = theme.useToken();
  // Stats
  const upnConflicts = users.filter((u) => u.upnStatus === 'conflict').length;
  const totalLicensesNeeded = users.reduce(
    (sum, u) => sum + u.licenses.filter((l: { assigned: boolean }) => l.assigned).length,
    0,
  );
  const usersWithGroupMembership = users.filter((u) => u.groups.length > 0).length;
  const notKnown = [...new Set(users.flatMap((u) => u.notKnown ?? []))];

  const columns = [
    {
      title: 'User',
      dataIndex: 'displayName',
      key: 'displayName',
      width: 200,
      render: (text: string, record: EntraUserMetadata) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Space size={4}>
            <MailOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {record.upn ?? 'UPN not known'}
            </Text>
          </Space>
        </Space>
      ),
    },
    {
      title: 'UPN Status',
      dataIndex: 'upnStatus',
      key: 'upnStatus',
      width: 180,
      render: (status: string, record: EntraUserMetadata) => (
        <Space direction="vertical" size={4}>
          {status === 'valid' ? (
            <Tag icon={<CheckCircleOutlined />} color="success">
              Valid
            </Tag>
          ) : status === 'conflict' ? (
            <Space direction="vertical" size={2}>
              <Tooltip
                title={
                  <Space direction="vertical" size={2}>
                    <span>{record.upnIssue}</span>
                    {record.candidatesChecked && record.candidatesChecked.length > 0 && (
                      <span>
                        Checked: {record.candidatesChecked.slice(0, 5).join(', ')}
                        {record.candidatesChecked.length > 5
                          ? ` +${record.candidatesChecked.length - 5} more`
                          : ''}
                      </span>
                    )}
                  </Space>
                }
              >
                <Tag icon={<WarningOutlined />} color="error">
                  Conflict
                </Tag>
              </Tooltip>
              {record.candidatesChecked && record.candidatesChecked.length > 0 ? (
                <Text type="secondary" style={{ fontSize: 10 }}>
                  Tried {record.candidatesChecked.length} candidates (all taken).
                  {record.suggestedUpn && ` Last: ${record.suggestedUpn}`}
                </Text>
              ) : record.suggestedUpn ? (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Suggestion:{' '}
                  <Text code style={{ fontSize: 10 }}>
                    {record.suggestedUpn}
                  </Text>
                </Text>
              ) : null}
            </Space>
          ) : (
            <Tooltip title={record.upnIssue ?? 'See "What this preview does not know"'}>
              <Tag icon={<QuestionCircleOutlined />} color="default">
                Not known
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Licenses',
      dataIndex: 'licenses',
      key: 'licenses',
      width: 250,
      render: (licenses: EntraUserMetadata['licenses']) => (
        <Space direction="vertical" size={2}>
          {licenses
            .filter((l) => l.assigned)
            .map((license, i) => (
              <Tooltip
                key={i}
                title={`${license.sku}: ${
                  license.available === null
                    ? 'units left not known (run Entra ID discovery)'
                    : `${license.available} units left`
                }`}
              >
                <Tag
                  color={
                    license.available === null ? 'default' : license.available > 0 ? 'blue' : 'red'
                  }
                  icon={<SafetyCertificateOutlined />}
                  style={{ fontSize: 11 }}
                >
                  {license.name}
                </Tag>
              </Tooltip>
            ))}
          {licenses.filter((l) => l.assigned).length === 0 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              No licenses assigned
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Groups',
      dataIndex: 'groups',
      key: 'groups',
      width: 250,
      render: (groups: string[]) =>
        groups.length > 0 ? (
          <div>
            {groups.slice(0, 3).map((group, i) => (
              <Tag
                key={i}
                icon={<SafetyOutlined />}
                color="geekblue"
                style={{ fontSize: 10, marginTop: 2 }}
              >
                {group}
              </Tag>
            ))}
            {groups.length > 3 && (
              <Tooltip title={groups.slice(3).join(', ')}>
                <Tag style={{ fontSize: 10 }}>+{groups.length - 3} more</Tag>
              </Tooltip>
            )}
          </div>
        ) : (
          <Text type="secondary" style={{ fontSize: 11 }}>
            No groups
          </Text>
        ),
    },
    {
      title: 'Directory Roles',
      dataIndex: 'roles',
      key: 'roles',
      width: 200,
      render: (roles: string[] | undefined) =>
        roles && roles.length > 0 ? (
          <div>
            {roles.map((role) => (
              <Tag
                key={role}
                icon={<CrownOutlined />}
                color="purple"
                style={{ fontSize: 10, marginTop: 2 }}
              >
                {role}
              </Tag>
            ))}
          </div>
        ) : (
          <Text type="secondary" style={{ fontSize: 11 }}>
            No roles
          </Text>
        ),
    },
  ];

  return (
    <div>
      <Title level={5}>
        <Space>
          <SafetyCertificateOutlined />
          Entra ID Provisioning Metadata
        </Space>
      </Title>

      {/* UPN Conflict Warning */}
      {upnConflicts > 0 && (
        <Alert
          message="UPN Conflicts Detected"
          description={
            <Space direction="vertical" size={4}>
              <span>
                {upnConflicts} user(s) have UserPrincipalName conflicts with existing Entra ID
                accounts. The resolver tried alternatives (e.g. firstname.middleinitial.lastname,
                firstname.lastname1).
              </span>
              <span>
                Check the <strong>Try</strong> suggestions in the table below, or configure a
                different UPN pattern in the Entra connector settings.
              </span>
            </Space>
          }
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* What the preview cannot tell */}
      {notKnown.length > 0 && (
        <Alert
          message="What this preview does not know"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {notKnown.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          }
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* License Availability Warning */}
      {users.some((u) =>
        u.licenses.some(
          (l: { assigned: boolean; available: number | null }) => l.assigned && l.available === 0,
        ),
      ) && (
        <Alert
          message="License Shortage Detected"
          description="Some users require licenses that are no longer available in your tenant. Purchase additional licenses or reassign existing ones."
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Summary Stats */}
      <Card size="small" style={{ marginBottom: 16, background: token.colorPrimaryBg }}>
        <Space split={<Divider type="vertical" />} size="large">
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Total Users
            </Text>
            <div>
              <Text strong style={{ fontSize: 18 }}>
                {users.length}
              </Text>
            </div>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              UPN Conflicts
            </Text>
            <div>
              <Text
                strong
                style={{
                  fontSize: 18,
                  color: upnConflicts > 0 ? token.colorError : token.colorSuccess,
                }}
              >
                {upnConflicts}
              </Text>
            </div>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Licenses Required
            </Text>
            <div>
              <Text strong style={{ fontSize: 18 }}>
                {totalLicensesNeeded}
              </Text>
            </div>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Users with Groups
            </Text>
            <div>
              <Text strong style={{ fontSize: 18 }}>
                {usersWithGroupMembership}
              </Text>
            </div>
          </div>
        </Space>
      </Card>

      {/* Main Table */}
      <Table
        dataSource={users}
        columns={columns}
        pagination={{ pageSize: 20 }}
        size="small"
        rowKey="userId"
        loading={loading}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};
