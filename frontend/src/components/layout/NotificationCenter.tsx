/**
 * Notification bell with dropdown tray — persists event history from WebSocket.
 * Shows unread badge, event list with click-through navigation, type filtering.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Badge, Button, Dropdown, Typography, Space, Tag, Empty, theme, Divider } from 'antd';
import {
  BellOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  InfoCircleOutlined,
  CloseCircleOutlined,
  ClearOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useRealTimeEvents, type DomainEventMessage } from '@api/realtime';

const { Text } = Typography;

interface NotificationItem {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  timestamp: Date;
  read: boolean;
  navigateTo?: string;
}

const MAX_ITEMS = 50;

const TYPE_ICONS: Record<
  NotificationItem['type'],
  React.ComponentType<{ style?: React.CSSProperties }>
> = {
  info: InfoCircleOutlined,
  success: CheckCircleOutlined,
  warning: WarningOutlined,
  error: CloseCircleOutlined,
};

/** antd status presets (token-driven, follow light/dark). */
const TYPE_TAG: Record<NotificationItem['type'], string> = {
  info: 'processing',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

function mapEventToNotification(event: DomainEventMessage): NotificationItem | null {
  const payload = (event.payload || {}) as Record<string, unknown>;
  const id = `${event.eventType}-${event.timestamp}-${Math.random().toString(36).slice(2, 6)}`;

  const mapping: Record<
    string,
    { type: NotificationItem['type']; title: string; navigateTo?: string }
  > = {
    'drift.detected': {
      type: 'warning',
      title: `Drift detected: ${(payload.userDisplayName as string) || (payload.identityId as string) || 'Unknown'}`,
      navigateTo: '/reconciliation',
    },
    'drift.resolved': {
      type: 'success',
      title: `Drift resolved: ${(payload.userDisplayName as string) || (payload.identityId as string) || 'Unknown'}`,
      navigateTo: '/reconciliation',
    },
    'provisioning.completed': {
      type: 'success',
      title: `Provisioning complete: ${(payload.connector as string) || 'Unknown'}`,
    },
    'provisioning.failed': {
      type: 'error',
      title: `Provisioning failed: ${(payload.connector as string) || 'Unknown'}`,
    },
    'anomaly.detected': {
      type: 'warning',
      title: `Anomaly: ${(payload.title as string) || (payload.type as string) || 'Detected'}`,
      navigateTo: '/intelligence/risk',
    },
    'identity.created': {
      type: 'info',
      // The event carries no name or email, only ids and the source
      title: payload.sourceSystem
        ? `New identity via ${payload.sourceSystem as string}`
        : 'New identity',
      navigateTo: '/users',
    },
    'connector.health_changed': {
      type: 'warning',
      title: `Connector ${(payload.connectorName as string) || (payload.name as string) || 'Unknown'}: ${(payload.status as string) || 'changed'}`,
      navigateTo: '/connectors',
    },
    'access_review.campaign_activated': {
      type: 'info',
      title: `Access Review started: ${(payload.name as string) || 'Campaign'}`,
      navigateTo: '/intelligence/reviews',
    },
  };

  const match = mapping[event.eventType];
  if (!match) return null;

  return {
    id,
    type: match.type,
    title: match.title,
    timestamp: new Date(event.timestamp),
    read: false,
    navigateTo: match.navigateTo,
  };
}

const ALL_ROOMS = [
  'anomalies',
  'provisioning',
  'drift',
  'reviews',
  'system',
  'audit',
  'identity',
  'connectors',
  'pipeline',
];

export const NotificationCenter: React.FC = () => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);

  useRealTimeEvents(
    ALL_ROOMS,
    useCallback((event: DomainEventMessage) => {
      const notification = mapEventToNotification(event);
      if (!notification) return;
      setItems((prev) => [notification, ...prev].slice(0, MAX_ITEMS));
    }, []),
  );

  const unreadCount = items.filter((i) => !i.read).length;
  const typeColor: Record<NotificationItem['type'], string> = {
    info: token.colorInfo,
    success: token.colorSuccess,
    warning: token.colorWarning,
    error: token.colorError,
  };

  const markAllRead = useCallback(() => {
    setItems((prev) => prev.map((i) => ({ ...i, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
    setOpen(false);
  }, []);

  const handleItemClick = useCallback(
    (item: NotificationItem) => {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
      if (item.navigateTo) {
        navigate(item.navigateTo);
        setOpen(false);
      }
    },
    [navigate],
  );

  // Mark all read when tray opens
  useEffect(() => {
    if (open && unreadCount > 0) {
      const timer = setTimeout(markAllRead, 2000);
      return () => clearTimeout(timer);
    }
  }, [open, unreadCount, markAllRead]);

  const formatTime = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return date.toLocaleDateString();
  };

  const trayContent = (
    <div
      className="notification-tray-enter"
      style={{
        width: 380,
        maxHeight: 480,
        overflow: 'auto',
        background: token.colorBgElevated,
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${token.colorBorder}`,
        boxShadow: token.boxShadowSecondary,
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Text strong>Notifications</Text>
        <Space size={4}>
          {items.length > 0 && (
            <Button type="text" size="small" icon={<ClearOutlined />} onClick={clearAll}>
              Clear
            </Button>
          )}
        </Space>
      </div>
      <Divider style={{ margin: 0 }} />
      {items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No notifications"
          style={{ padding: '32px 0' }}
        />
      ) : (
        items.map((item) => (
          <div
            key={item.id}
            className="euroid-row-action"
            onClick={() => handleItemClick(item)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleItemClick(item);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`${item.title}${item.read ? '' : ' (unread)'}`}
            style={{
              padding: '10px 16px',
              cursor: item.navigateTo ? 'pointer' : 'default',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              background: item.read ? 'transparent' : token.colorFillQuaternary,
            }}
          >
            <Space size={8} align="start">
              {React.createElement(TYPE_ICONS[item.type], {
                style: { color: typeColor[item.type] },
              })}
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 13, display: 'block' }} ellipsis>
                  {item.title}
                </Text>
                <Space size={8}>
                  <Tag
                    color={TYPE_TAG[item.type]}
                    style={{ fontSize: 11, lineHeight: '16px', margin: 0 }}
                  >
                    {item.type}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {formatTime(item.timestamp)}
                  </Text>
                </Space>
              </div>
              {!item.read && (
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: token.colorPrimary,
                    flexShrink: 0,
                    marginTop: 6,
                  }}
                />
              )}
            </Space>
          </div>
        ))
      )}
    </div>
  );

  return (
    <Dropdown
      dropdownRender={() => trayContent}
      trigger={['click']}
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
    >
      <Badge count={unreadCount} size="small" offset={[-2, 2]}>
        <Button
          type="text"
          icon={<BellOutlined style={{ fontSize: 18 }} />}
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        />
      </Badge>
    </Dropdown>
  );
};
