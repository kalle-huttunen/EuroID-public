import React from 'react';
import { Result, Spin } from 'antd';
import { usePlatformAdmin } from './usePlatformAdmin';

/**
 * Renders its children only for a platform admin (as GET /auth/me reports it), else a 403.
 * Place it inside ProtectedRoute, which handles sign-in. Unlike ProtectedRoute's role check it
 * has no dev-mode bypass: the backend decides platform admin in every mode.
 */
export function PlatformAdminRoute({ children }: { children: React.ReactNode }) {
  const { isPlatformAdmin, isLoading } = usePlatformAdmin();

  if (isLoading) {
    return (
      <div
        style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!isPlatformAdmin) {
    return (
      <Result
        status="403"
        title="Access Denied"
        subTitle="Only a platform admin of this deployment can manage tenants."
      />
    );
  }

  return <>{children}</>;
}
