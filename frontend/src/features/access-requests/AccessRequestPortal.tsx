/**
 * Access requests: self-service catalog, my requests, approvals, and for a policy-admin the
 * requests whose removal keeps failing.
 * The active tab is derived from the route: /access-requests/approvals selects
 * approvals, ?tab=my-requests selects my requests, ?tab=removal-failing the failing removals
 * (policy-admin; others get the catalog), anything else the catalog.
 */
import React from 'react';
import { Tabs } from 'antd';
import {
  ShoppingCartOutlined,
  UnorderedListOutlined,
  CheckSquareOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { EntitlementBrowser } from './EntitlementBrowser';
import { MyRequests } from './MyRequests';
import { ApprovalQueue } from './ApprovalQueue';
import { RemovalFailing } from './RemovalFailing';
import { usePermission } from '../../auth/usePermission';

type PortalTab = 'browse' | 'my-requests' | 'approvals' | 'removal-failing';

const TAB_ROUTES: Record<PortalTab, string> = {
  browse: '/access-requests',
  'my-requests': '/access-requests?tab=my-requests',
  approvals: '/access-requests/approvals',
  'removal-failing': '/access-requests?tab=removal-failing',
};

function tabFromLocation(pathname: string, search: string, canClose: boolean): PortalTab {
  if (pathname.endsWith('/approvals')) return 'approvals';
  const tab = new URLSearchParams(search).get('tab');
  if (tab === 'my-requests') return 'my-requests';
  return tab === 'removal-failing' && canClose ? 'removal-failing' : 'browse';
}

export const AccessRequestPortal: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  // The list is tenant-wide and its requests are closed by hand: policy-admin, as the API
  const canCloseRemovals = usePermission('policy-admin');
  const activeTab = tabFromLocation(location.pathname, location.search, canCloseRemovals);

  return (
    <PageContainer>
      <PageHeader
        title="Access requests"
        subtitle="Request entitlements from the catalog, follow your requests and act on approvals."
      />
      <Tabs
        activeKey={activeTab}
        onChange={(key) => navigate(TAB_ROUTES[key as PortalTab])}
        items={[
          {
            key: 'browse',
            label: 'Browse catalog',
            icon: <ShoppingCartOutlined />,
            children: <EntitlementBrowser />,
          },
          {
            key: 'my-requests',
            label: 'My requests',
            icon: <UnorderedListOutlined />,
            children: <MyRequests />,
          },
          {
            key: 'approvals',
            label: 'Pending approvals',
            icon: <CheckSquareOutlined />,
            children: <ApprovalQueue />,
          },
          ...(canCloseRemovals
            ? [
                {
                  key: 'removal-failing',
                  label: 'Removal failing',
                  icon: <WarningOutlined />,
                  children: <RemovalFailing />,
                },
              ]
            : []),
        ]}
      />
    </PageContainer>
  );
};
