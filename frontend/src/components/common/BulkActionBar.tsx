/**
 * Floating bulk action bar — appears at bottom when table rows are selected.
 * Shows selected count + action buttons. Slides up with animation.
 */
import React from 'react';
import { Button, Space, Typography, theme } from 'antd';
import { CloseOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface BulkAction {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  danger?: boolean;
  loading?: boolean;
}

interface BulkActionBarProps {
  selectedCount: number;
  actions: BulkAction[];
  onClear: () => void;
}

export const BulkActionBar: React.FC<BulkActionBarProps> = ({
  selectedCount,
  actions,
  onClear,
}) => {
  const { token } = theme.useToken();

  if (selectedCount === 0) return null;

  return (
    <div
      className="bulk-bar-enter"
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadiusLG,
        padding: '12px 20px',
        boxShadow: token.boxShadowSecondary,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        minWidth: 320,
      }}
      role="toolbar"
      aria-label={`${selectedCount} items selected`}
    >
      <Text strong>
        {selectedCount} selected
      </Text>
      <Space size={8}>
        {actions.map((action) => (
          <Button
            key={action.label}
            size="small"
            type={action.danger ? 'default' : 'primary'}
            danger={action.danger}
            icon={action.icon}
            onClick={action.onClick}
            loading={action.loading}
          >
            {action.label}
          </Button>
        ))}
      </Space>
      <Button
        type="text"
        size="small"
        icon={<CloseOutlined />}
        onClick={onClear}
        aria-label="Clear selection"
        style={{ marginLeft: 'auto' }}
      />
    </div>
  );
};
