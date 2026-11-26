/**
 * Breadcrumb for the desktop top bar: section / page / detail, derived from the
 * route and the shared navigation labels.
 */
import React from 'react';
import { Breadcrumb } from 'antd';
import { useLocation, Link } from 'react-router-dom';
import { matchNavItem } from './navigation';

/** Detail routes that are not in the sidebar. */
const DETAIL_ROUTES: Array<{
  pattern: RegExp;
  parent: string;
  parentLabel: string;
  label: string;
}> = [
  {
    pattern: /^\/identity\/[^/]+\/map$/,
    parent: '/users',
    parentLabel: 'Identity hub',
    label: 'Entitlement map',
  },
  {
    pattern: /^\/identities\/[^/]+$/,
    parent: '/users',
    parentLabel: 'Identity hub',
    label: 'Identity',
  },
  {
    pattern: /^\/access-requests\/(?!approvals$)[^/]+$/,
    parent: '/access-requests',
    parentLabel: 'Access requests',
    label: 'Request detail',
  },
];

export const AppBreadcrumbs: React.FC = () => {
  const { pathname } = useLocation();

  const items: Array<{ title: React.ReactNode }> = [];
  const detail = DETAIL_ROUTES.find((d) => d.pattern.test(pathname));

  if (detail) {
    items.push({ title: <Link to={detail.parent}>{detail.parentLabel}</Link> });
    items.push({ title: detail.label });
  } else {
    const match = matchNavItem(pathname);
    if (!match) return null;
    if (match.section) items.push({ title: match.section });
    items.push({ title: <span aria-current="page">{match.label}</span> });
  }

  return <Breadcrumb items={items} />;
};
