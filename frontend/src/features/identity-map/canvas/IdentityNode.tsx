/**
 * IdentityNode — center node for the Identity Entitlement Map.
 * Displays: user name, job title, email, status badge, risk score.
 */

import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Space, Tag, Typography, theme } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { SEMANTIC, BRAND } from '@theme/themeConfig';
import { getUserStatusColor } from '../../../interfaces';

const { Text, Title } = Typography;

export interface IdentityNodeData {
  displayName: string;
  email: string;
  jobTitle?: string;
  status: string;
  riskScore: number | null;
  [key: string]: unknown;
}

function getRiskColor(score: number | null): string {
  if (score === null) return BRAND.edgeStroke;
  if (score < 40) return SEMANTIC.statusSynced;
  if (score < 70) return SEMANTIC.statusDriftText;
  return SEMANTIC.statusError;
}

export const IdentityNode: React.FC<NodeProps> = ({ data }) => {
  const { token } = theme.useToken();
  const { displayName, email, jobTitle, status, riskScore } = data as unknown as IdentityNodeData;

  return (
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        background: token.colorBgContainer,
        border: `2px solid ${token.colorPrimary}`,
        boxShadow: `0 4px 12px ${token.colorPrimary}33`,
        minWidth: 220,
        textAlign: 'center',
      }}
      role="group"
      aria-label={`Identity: ${displayName}`}
    >
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <UserOutlined style={{ fontSize: 28, color: token.colorPrimary }} />
        <Title level={5} style={{ margin: 0 }}>
          {displayName}
        </Title>
        {jobTitle && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {jobTitle}
          </Text>
        )}
        <Text type="secondary" style={{ fontSize: 11 }}>
          {email}
        </Text>
        <Space size={4}>
          <Tag color={getUserStatusColor(status as Parameters<typeof getUserStatusColor>[0])}>
            {status}
          </Tag>
          {riskScore !== null && <Tag color={getRiskColor(riskScore)}>Risk: {riskScore}</Tag>}
        </Space>
      </Space>
      <Handle type="source" position={Position.Bottom} id="to-targets" />
      <Handle type="source" position={Position.Right} id="to-admins" />
    </div>
  );
};
