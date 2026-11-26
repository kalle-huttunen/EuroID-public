/**
 * DriftBadge — amber drift indicator with count.
 * Used inside TargetSystemNode to show active drift count.
 */

import React from 'react';
import { Badge, theme } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { SEMANTIC } from '@theme/themeConfig';

interface DriftBadgeProps {
  count: number;
  onClick?: () => void;
}

export const DriftBadge: React.FC<DriftBadgeProps> = ({ count, onClick }) => {
  const { token } = theme.useToken();

  if (count === 0) return null;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
          onClick?.();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${count} drift${count !== 1 ? 's' : ''} detected`}
      style={{
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 12,
        background: `${SEMANTIC.statusDrift}20`,
        border: `1px solid ${SEMANTIC.statusDrift}`,
        fontSize: 11,
        color: token.colorText,
      }}
    >
      <WarningOutlined style={{ color: SEMANTIC.statusDrift }} />
      <Badge count={count} style={{ backgroundColor: SEMANTIC.statusDriftText }} size="small" />
    </div>
  );
};
