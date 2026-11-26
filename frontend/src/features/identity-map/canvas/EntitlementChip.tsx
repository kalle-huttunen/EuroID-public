/**
 * EntitlementChip — pill-shaped node for a single entitlement.
 * Displays: name, type icon, governance badge, risk level color.
 */

import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Space, Tag, Typography, theme } from 'antd';
import { TeamOutlined, IdcardOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { SEMANTIC } from '@theme/themeConfig';

const { Text } = Typography;

export interface EntitlementChipData {
  name: string;
  type: 'Group' | 'License' | 'DirectoryRole';
  governanceLevel?: 'STRICT' | 'OPEN';
  /** How the identity holds it: a policy or an access request. EXTERNAL is a catalogue origin. */
  origin: 'POLICY' | 'REQUEST' | 'EXTERNAL';
  sourcePolicy?: string;
  isProvisioned: boolean;
  /** End of the access a time-bound access request granted (REQUEST only), ISO 8601. */
  expiresAt?: string;
  [key: string]: unknown;
}

const TYPE_ICONS: Record<string, React.ReactNode> = {
  Group: <TeamOutlined />,
  License: <IdcardOutlined />,
  DirectoryRole: <SafetyCertificateOutlined />,
};

export const EntitlementChip: React.FC<NodeProps> = ({ data }) => {
  const { token } = theme.useToken();
  const { name, type, governanceLevel, origin, isProvisioned } =
    data as unknown as EntitlementChipData;

  const borderColor = isProvisioned ? token.colorBorder : token.colorPrimary;
  const borderStyle = isProvisioned ? 'solid' : 'dashed';
  const governanceColor =
    governanceLevel === 'STRICT' ? SEMANTIC.statusError : SEMANTIC.statusSynced;

  return (
    <div
      style={{
        padding: '6px 12px',
        borderRadius: 16,
        background: token.colorBgContainer,
        border: `1px ${borderStyle} ${borderColor}`,
        minWidth: 140,
        cursor: 'pointer',
      }}
      role="button"
      aria-label={`Entitlement: ${name} (${type})`}
      tabIndex={0}
    >
      <Handle type="target" position={Position.Top} id="from-target" />
      <Space size={4} align="center">
        <span style={{ color: token.colorPrimary, fontSize: 12 }}>
          {TYPE_ICONS[type] ?? TYPE_ICONS.Group}
        </span>
        <Text style={{ fontSize: 12, maxWidth: 120 }} ellipsis={{ tooltip: name }}>
          {name}
        </Text>
        {governanceLevel && (
          <Tag
            color={governanceColor}
            style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}
          >
            {governanceLevel}
          </Tag>
        )}
        {origin === 'EXTERNAL' && (
          <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>EXT</Tag>
        )}
      </Space>
    </div>
  );
};
