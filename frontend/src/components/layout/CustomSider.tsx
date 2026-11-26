/**
 * App sidebar: one grouped Menu, "EuroID" wordmark, collapse control.
 * Responsive: < 1024px auto-collapses to icons; < 768px becomes a drawer opened
 * from MobileHeader (the drawer keeps theme switch, account and sign out, since
 * the desktop top bar is hidden there).
 * Always dark (nested ConfigProvider with siderTheme). The active item carries
 * the single EU-gold mark (src/styles/app.css, .euroid-nav).
 */
import React, { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import {
  Layout,
  Menu,
  Button,
  Typography,
  Grid,
  Drawer,
  Switch,
  ConfigProvider,
  Badge,
} from 'antd';
import type { MenuProps } from 'antd';
import { LeftOutlined, RightOutlined, LogoutOutlined, LockOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { uncorrelatedKeys } from '@api/identity-api';
import { usePendingApprovalsCount } from '@api/access-requests-api';
import { useAuthContext } from '../../auth/auth-context';
import { usePermission } from '../../auth/usePermission';
import { usePlatformAdmin } from '../../auth/usePlatformAdmin';
import { useTenant } from '../../auth/use-tenant';
import { useMobileMenu } from './MobileMenuContext';
import { visibleNavSections, matchNavItem, type NavAccess } from './navigation';
import { siderTheme, BRAND } from '../../theme';
import { ColorModeContext } from '../../contexts/color-mode';

const { Sider } = Layout;
const { useBreakpoint } = Grid;
const { Text } = Typography;

type MenuItem = Required<MenuProps>['items'][number];

const SIDER_WIDTH = 240;
const SIDER_COLLAPSED_WIDTH = 72;

function withCount(label: string, count: number): React.ReactNode {
  if (count <= 0) return label;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {label}
      <Badge count={count} size="small" color={BRAND.primaryOnDark} />
    </span>
  );
}

function buildMenuItems(counts: Record<string, number>, access: NavAccess): MenuItem[] {
  return visibleNavSections(access).flatMap<MenuItem>((section) => {
    const children: MenuItem[] = section.items.map((item) => ({
      key: item.path,
      icon: item.icon,
      label: withCount(item.label, counts[item.path] ?? 0),
      title: item.label,
    }));
    if (!section.title) return children;
    return [{ key: `group-${section.key}`, type: 'group', label: section.title, children }];
  });
}

const Wordmark: React.FC<{ collapsed: boolean }> = ({ collapsed }) => {
  const { tenantName } = useTenant();
  return (
    <div
      style={{
        height: 64,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: collapsed ? 'center' : 'flex-start',
        padding: collapsed ? 0 : '0 20px',
        borderBottom: `1px solid ${BRAND.siderBorder}`,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          color: BRAND.siderLogoColor,
          fontSize: collapsed ? 18 : 19,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          lineHeight: 1.2,
        }}
      >
        {collapsed ? 'E' : 'EuroID'}
      </span>
      {!collapsed && tenantName && (
        <Text
          style={{ color: BRAND.siderText, fontSize: 12, lineHeight: 1.4, maxWidth: '100%' }}
          ellipsis={{ tooltip: tenantName }}
        >
          {tenantName}
        </Text>
      )}
    </div>
  );
};

export const CustomSider: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const { open: mobileMenuOpen, setOpen: setMobileMenuOpen } = useMobileMenu();
  const location = useLocation();
  const navigate = useNavigate();
  const screens = useBreakpoint();
  const auth = useAuthContext();
  const isSuperAdmin = usePermission('super-admin');
  const isOperator = usePermission('operator');
  const isPolicyAdmin = usePermission('policy-admin');
  const { isPlatformAdmin } = usePlatformAdmin();
  const { mode, setMode } = useContext(ColorModeContext);

  const isMobile = !screens.md;
  const isMedium = !screens.lg;

  useEffect(() => {
    if (isMedium && !isMobile) {
      queueMicrotask(() => setCollapsed(true));
    }
  }, [isMedium, isMobile]);

  useEffect(() => {
    if (isMobile) {
      setMobileMenuOpen(false);
    }
  }, [location.pathname, isMobile, setMobileMenuOpen]);

  const { data: uncorrelatedCount = 0 } = useQuery({
    queryKey: uncorrelatedKeys.count(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<{ count: number }>(
        `${API_BASE}/identity/uncorrelated/count`,
      );
      return data?.count ?? 0;
    },
  });

  const { data: pendingApprovalsCount = 0 } = usePendingApprovalsCount();

  const menuItems = useMemo(
    () =>
      buildMenuItems(
        {
          '/reconciliation/uncorrelated': uncorrelatedCount,
          '/access-requests/approvals': pendingApprovalsCount,
        },
        { isSuperAdmin, isPlatformAdmin, isOperator, isPolicyAdmin },
      ),
    [
      uncorrelatedCount,
      pendingApprovalsCount,
      isSuperAdmin,
      isPlatformAdmin,
      isOperator,
      isPolicyAdmin,
    ],
  );

  const selectedKey =
    matchNavItem(location.pathname)?.path ??
    (/^\/identit(y|ies)\//.test(location.pathname) ? '/users' : '');

  const handleMenuClick: MenuProps['onClick'] = useCallback(
    ({ key }: { key: string }) => {
      navigate(key);
      if (isMobile) setMobileMenuOpen(false);
    },
    [navigate, isMobile, setMobileMenuOpen],
  );

  const menu = (
    <Menu
      className="euroid-nav"
      mode="inline"
      theme="dark"
      selectedKeys={selectedKey ? [selectedKey] : []}
      onClick={handleMenuClick}
      items={menuItems}
      style={{ backgroundColor: 'transparent', borderRight: 'none', paddingBottom: 8 }}
    />
  );

  if (isMobile) {
    const userName = auth.user?.profile?.name || auth.user?.profile?.email || 'User';
    const userEmail = auth.user?.profile?.email;
    return (
      <ConfigProvider theme={siderTheme}>
        <div
          style={{ width: 0, minWidth: 0, overflow: 'hidden', flexShrink: 0 }}
          role="navigation"
          aria-label="Navigation menu"
        >
          <Drawer
            placement="left"
            open={mobileMenuOpen}
            onClose={() => setMobileMenuOpen(false)}
            width={264}
            styles={{
              body: {
                padding: 0,
                background: BRAND.siderBg,
                display: 'flex',
                flexDirection: 'column',
              },
              header: { display: 'none' },
            }}
            aria-label="Navigation menu"
          >
            <Wordmark collapsed={false} />
            <div style={{ overflowY: 'auto', flex: 1 }}>{menu}</div>
            {auth.isAuthenticated && (
              <div style={{ borderTop: `1px solid ${BRAND.siderBorder}`, padding: '12px 16px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 12,
                  }}
                >
                  <Text style={{ fontSize: 13, color: BRAND.siderText }}>Dark mode</Text>
                  <Switch
                    size="small"
                    checked={mode === 'dark'}
                    onChange={() => setMode()}
                    aria-label="Toggle dark mode"
                  />
                </div>
                <Text
                  strong
                  style={{ fontSize: 13, display: 'block', color: BRAND.siderTextActive }}
                >
                  {userName}
                </Text>
                {userEmail && (
                  <Text style={{ fontSize: 12, display: 'block', color: BRAND.siderText }}>
                    {userEmail}
                  </Text>
                )}
                <Button
                  type="text"
                  size="small"
                  icon={<LockOutlined />}
                  onClick={() => {
                    navigate('/settings/security');
                    setMobileMenuOpen(false);
                  }}
                  style={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    marginTop: 8,
                    color: BRAND.siderText,
                  }}
                >
                  Account security
                </Button>
                <Button
                  type="text"
                  size="small"
                  icon={<LogoutOutlined />}
                  onClick={() => {
                    auth.signoutRedirect?.();
                    setMobileMenuOpen(false);
                  }}
                  style={{ width: '100%', justifyContent: 'flex-start', color: BRAND.siderText }}
                >
                  Sign out
                </Button>
              </div>
            )}
          </Drawer>
        </div>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={siderTheme}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={SIDER_WIDTH}
        collapsedWidth={SIDER_COLLAPSED_WIDTH}
        trigger={null}
        role="navigation"
        aria-label="Main navigation"
        style={{
          backgroundColor: BRAND.siderBg,
          height: '100vh',
          position: 'sticky',
          top: 0,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Wordmark collapsed={collapsed} />

          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingTop: 8 }}>
            {menu}
          </div>

          <div style={{ borderTop: `1px solid ${BRAND.siderBorder}`, padding: 8, flexShrink: 0 }}>
            <Button
              type="text"
              icon={collapsed ? <RightOutlined /> : <LeftOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              style={{
                width: '100%',
                justifyContent: collapsed ? 'center' : 'flex-start',
                color: BRAND.siderText,
              }}
            >
              {collapsed ? null : 'Collapse'}
            </Button>
          </div>
        </div>
      </Sider>
    </ConfigProvider>
  );
};
