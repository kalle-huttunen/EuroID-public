import React, { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthContext } from './auth-context';
import { Spin, Result } from 'antd';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: string;
  /** Called when not authenticated - e.g. signinRedirect for OIDC */
  onNotAuthenticated?: () => void;
}

const ROLE_HIERARCHY: Record<string, string[]> = {
  'super-admin': ['super-admin', 'connector-admin', 'policy-admin', 'operator', 'viewer'],
  'connector-admin': ['connector-admin', 'operator', 'viewer'],
  'policy-admin': ['policy-admin', 'operator', 'viewer'],
  'operator': ['operator', 'viewer'],
  'viewer': ['viewer'],
};

function hasRole(userRoles: string[], requiredRole: string): boolean {
  return userRoles.some((role) => {
    const granted = ROLE_HIERARCHY[role] ?? [];
    return granted.includes(requiredRole);
  });
}

export function ProtectedRoute({ children, requiredRole, onNotAuthenticated }: ProtectedRouteProps) {
  const isDevMode = import.meta.env.DEV && import.meta.env.VITE_AUTH_DISABLED === 'true';
  const auth = useAuthContext();

  useEffect(() => {
    if (isDevMode) return;
    if (!auth.isLoading && !auth.isAuthenticated && onNotAuthenticated) {
      onNotAuthenticated();
    }
  }, [isDevMode, auth.isLoading, auth.isAuthenticated, onNotAuthenticated]);

  if (isDevMode) {
    return <>{children}</>;
  }

  if (auth.isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    if (onNotAuthenticated) {
      // The redirect runs in the effect above; navigating during render is a React error.
      return (
        <Spin spinning fullscreen size="large" tip="Redirecting to sign in..." />
      );
    }
    return <Navigate to="/login" replace />;
  }

  if (requiredRole) {
    const userRoles = (auth.user?.profile?.roles as string[] | undefined) ?? [];
    if (!hasRole(userRoles, requiredRole)) {
      return <Result status="403" title="Access Denied" subTitle="You do not have permission to view this page." />;
    }
  }

  return <>{children}</>;
}
