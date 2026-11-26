import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Layout } from 'antd';
import { useAuthContext } from './auth-context';
import { MFA_ENROLLMENT_PATH } from './mfa-enrollment';

/**
 * Wraps the app layout of the signed-in routes (App.tsx `ProtectedAppLayout`). While the session
 * can only set up MFA (`mfaEnrollmentOnly`, auth/mfa-enrollment.ts), MFA setup is the only page:
 * it is shown without the app layout, whose navigation and counters query routes that refuse the
 * token (403), and every other route sends back to it.
 */
export function MfaEnrollmentGate({ children }: { children: React.ReactNode }) {
  const auth = useAuthContext();
  const location = useLocation();

  if (!auth.mfaEnrollmentOnly) return <>{children}</>;

  if (location.pathname + location.search !== MFA_ENROLLMENT_PATH) {
    return <Navigate to={MFA_ENROLLMENT_PATH} replace />;
  }
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Content id="main-content">
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
