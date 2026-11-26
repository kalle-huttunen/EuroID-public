/**
 * Desktop top bar (48px): breadcrumb on the left; search, connection status,
 * notifications, theme toggle and user menu on the right. Hidden below md —
 * MobileHeader covers small screens.
 */
import React, { useContext } from 'react';
import { Avatar, Button, Dropdown, Grid, Tooltip, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import {
  SearchOutlined,
  SunOutlined,
  MoonOutlined,
  LockOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../../auth/auth-context';
import { ColorModeContext } from '../../contexts/color-mode';
import { useCommandPaletteStore } from '@stores/command-palette-store';
import { AppBreadcrumbs } from './AppBreadcrumbs';
import { NotificationCenter } from './NotificationCenter';
import { ConnectionStatus } from './ConnectionStatus';

const { useBreakpoint } = Grid;
const { Text } = Typography;

const TOP_BAR_HEIGHT = 48;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const TopBar: React.FC = () => {
  const { token } = theme.useToken();
  const screens = useBreakpoint();
  const navigate = useNavigate();
  const auth = useAuthContext();
  const { mode, setMode } = useContext(ColorModeContext);
  const openPalette = useCommandPaletteStore((s) => s.setOpen);

  if (!screens.md) return null;

  const profile = auth.user?.profile;
  const userName = profile?.name || profile?.email || 'User';
  const role = (profile?.roles?.[0] as string | undefined) ?? 'viewer';

  const userMenu: MenuProps = {
    items: [
      {
        key: 'identity',
        type: 'group',
        label: (
          <div style={{ padding: '2px 0 4px', minWidth: 200 }}>
            <Text strong style={{ display: 'block', color: token.colorText }}>
              {userName}
            </Text>
            {profile?.email && (
              <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {profile.email}
              </Text>
            )}
            <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              Role: {role}
            </Text>
          </div>
        ),
      },
      { type: 'divider' },
      { key: 'security', icon: <LockOutlined />, label: 'Account security' },
      { key: 'signout', icon: <LogoutOutlined />, label: 'Sign out' },
    ],
    onClick: ({ key }) => {
      if (key === 'security') navigate('/settings/security');
      if (key === 'signout') auth.signoutRedirect?.();
    },
  };

  const themeLabel = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        height: TOP_BAR_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px 0 24px',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
      }}
    >
      <nav aria-label="Breadcrumb" style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <AppBreadcrumbs />
      </nav>

      <button
        type="button"
        className="euroid-search-pill"
        onClick={() => openPalette(true)}
        aria-label="Search identities and pages"
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 32,
          width: 240,
          padding: '0 8px 0 12px',
          border: `1px solid ${token.colorBorder}`,
          borderRadius: 16,
          background: token.colorBgLayout,
          color: token.colorTextSecondary,
          font: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        <SearchOutlined aria-hidden />
        <span style={{ flex: 1, textAlign: 'left' }}>Search</span>
        <kbd
          style={{
            fontFamily: token.fontFamilyCode,
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 4,
            border: `1px solid ${token.colorBorder}`,
            background: token.colorBgContainer,
            color: token.colorTextSecondary,
          }}
        >
          {isMac ? '⌘ K' : 'Ctrl K'}
        </kbd>
      </button>

      <ConnectionStatus />
      <NotificationCenter />

      <Tooltip title={themeLabel}>
        <Button
          type="text"
          aria-label={themeLabel}
          icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
          onClick={() => setMode()}
        />
      </Tooltip>

      <Dropdown menu={userMenu} trigger={['click']} placement="bottomRight">
        <Button
          type="text"
          aria-label={`Account menu for ${userName}`}
          style={{ padding: '0 4px', height: 32 }}
        >
          <Avatar
            size={26}
            style={{
              background: token.colorPrimary,
              color: token.colorTextLightSolid,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {initials(userName)}
          </Avatar>
        </Button>
      </Dropdown>
    </header>
  );
};
