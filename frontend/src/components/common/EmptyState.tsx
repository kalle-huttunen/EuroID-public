/**
 * Reusable empty state with icon, title, description, and optional CTA.
 * Replaces bare text strings with contextual guidance.
 */
import React from 'react';
import { Empty, Button, Typography, Space } from 'antd';
import type { ButtonProps } from 'antd';

const { Text } = Typography;

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    type?: ButtonProps['type'];
    icon?: React.ReactNode;
  };
  style?: React.CSSProperties;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  style,
}) => (
  <Empty
    image={icon || Empty.PRESENTED_IMAGE_SIMPLE}
    description={
      <Space direction="vertical" size={4}>
        <Text strong>{title}</Text>
        {description && <Text type="secondary">{description}</Text>}
      </Space>
    }
    style={{ padding: '48px 0', ...style }}
  >
    {action && (
      <Button
        type={action.type ?? 'primary'}
        onClick={action.onClick}
        icon={action.icon}
      >
        {action.label}
      </Button>
    )}
  </Empty>
);
