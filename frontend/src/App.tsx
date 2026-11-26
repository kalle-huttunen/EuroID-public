import React, { Suspense } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@api/query-client';
import { AuthProvider } from 'react-oidc-context';
import { Layout, App as AntdApp, Skeleton, Result, Button, Grid } from 'antd';
import { ColorModeContextProvider } from './contexts/color-mode';
import { BrowserRouter, Route, Routes, Outlet, Navigate, useNavigate } from 'react-router-dom';
import './styles/animations.css';
import './styles/app.css';
import { CustomSider } from './components/layout/CustomSider';
import { TopBar } from './components/layout/TopBar';
import { CommandPalette } from './components/common/CommandPalette';
import { MobileHeader } from './components/layout/MobileHeader';
import { MobileMenuProvider } from './components/layout/MobileMenuContext';
import {
  ProtectedRoute,
  MfaEnrollmentGate,
  PlatformAdminRoute,
  AuthCallback,
  DevAuthProvider,
  OIDCAuthBridge,
  LocalAuthProvider,
} from './auth';
import { setReturnUrl } from './auth/return-url-store';
import { oidcConfig } from './auth/auth-config';
import { useAuthContext } from './auth/auth-context';
import { SocketProvider, useEventNotifications, useRealTimeQueryInvalidation } from '@api/realtime';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { LoginPage } from './features/auth/LoginPage';
import { DEV_TOOLS_ENABLED } from '@config/dev-tools';

const SamlCallbackPage = React.lazy(() =>
  import('./features/auth/SamlCallbackPage').then((m) => ({ default: m.SamlCallbackPage })),
);
const ResetPasswordPage = React.lazy(() =>
  import('./features/auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
);
const AccountSecurityPage = React.lazy(() =>
  import('./features/settings/AccountSecurityPage').then((m) => ({
    default: m.AccountSecurityPage,
  })),
);

const { Content } = Layout;

const DashboardPage = React.lazy(() =>
  import('./features/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
);
const UserList = React.lazy(() =>
  import('./features/users/UserList').then((m) => ({ default: m.UserList })),
);
const IdentityDetailPage = React.lazy(() =>
  import('./features/users/IdentityDetailPage').then((m) => ({ default: m.IdentityDetailPage })),
);
const BlueprintCanvas = React.lazy(() =>
  import('./features/blueprints/BlueprintCanvas').then((m) => ({ default: m.BlueprintCanvas })),
);
const ConnectorMarketplace = React.lazy(() =>
  import('./features/connectors/ConnectorMarketplace').then((m) => ({
    default: m.ConnectorMarketplace,
  })),
);
const ReconciliationDashboard = React.lazy(() =>
  import('./features/reconciliation/ReconciliationDashboard').then((m) => ({
    default: m.ReconciliationDashboard,
  })),
);
const UncorrelatedQueue = React.lazy(() =>
  import('./features/reconciliation/UncorrelatedQueue').then((m) => ({
    default: m.UncorrelatedQueue,
  })),
);
const BulkOperations = React.lazy(() =>
  import('./features/bulk-operations/BulkOperations').then((m) => ({ default: m.BulkOperations })),
);
const AuditDashboard = React.lazy(() =>
  import('./features/audit/AuditDashboard').then((m) => ({ default: m.AuditDashboard })),
);
const AuditIntegrityPage = React.lazy(() =>
  import('./features/audit-integrity/AuditIntegrityPage').then((m) => ({
    default: m.AuditIntegrityPage,
  })),
);
const ComplianceReports = React.lazy(() =>
  import('./features/compliance/ComplianceReports').then((m) => ({ default: m.default })),
);
const GdprPage = React.lazy(() =>
  import('./features/compliance/GdprPage').then((m) => ({ default: m.GdprPage })),
);
/** Developer pages; null in production builds so their chunks are not emitted at all. */
const devToolsPages = DEV_TOOLS_ENABLED
  ? {
      WorkflowDebugger: React.lazy(() =>
        import('./features/developers/WorkflowDebugger').then((m) => ({
          default: m.WorkflowDebugger,
        })),
      ),
      TransactionViewer: React.lazy(() =>
        import('./features/developers/TransactionViewer').then((m) => ({
          default: m.TransactionViewer,
        })),
      ),
    }
  : null;
const RiskDashboard = React.lazy(() =>
  import('./features/intelligence/RiskDashboard').then((m) => ({ default: m.RiskDashboard })),
);
const PeerGroupsPage = React.lazy(() =>
  import('./features/intelligence/PeerGroupsPage').then((m) => ({ default: m.PeerGroupsPage })),
);
const PolicySuggestions = React.lazy(() =>
  import('./features/intelligence/PolicySuggestions').then((m) => ({
    default: m.PolicySuggestions,
  })),
);
const RoleBasedRules = React.lazy(() =>
  import('./features/intelligence/RoleBasedRules').then((m) => ({ default: m.RoleBasedRules })),
);
const AccessReviews = React.lazy(() =>
  import('./features/intelligence/AccessReviews').then((m) => ({ default: m.AccessReviews })),
);
const Analytics = React.lazy(() =>
  import('./features/intelligence/Analytics').then((m) => ({ default: m.Analytics })),
);
const PrivilegedAccessDashboard = React.lazy(() =>
  import('./features/privileged-access/PrivilegedAccessDashboard').then((m) => ({
    default: m.PrivilegedAccessDashboard,
  })),
);
const AccessRequestPortal = React.lazy(() =>
  import('./features/access-requests/AccessRequestPortal').then((m) => ({
    default: m.AccessRequestPortal,
  })),
);
const RequestDetail = React.lazy(() =>
  import('./features/access-requests/RequestDetail').then((m) => ({ default: m.RequestDetail })),
);
const SCIMSettings = React.lazy(() =>
  import('./features/admin/SCIMSettings').then((m) => ({ default: m.SCIMSettings })),
);
const TenantManagement = React.lazy(() =>
  import('./features/admin/TenantManagement').then((m) => ({ default: m.TenantManagement })),
);
const LeaversPage = React.lazy(() =>
  import('./features/leavers/LeaversPage').then((m) => ({ default: m.LeaversPage })),
);
const DeadLetterPage = React.lazy(() =>
  import('./features/dead-letter/DeadLetterPage').then((m) => ({ default: m.DeadLetterPage })),
);
const CredentialLifecyclePage = React.lazy(() =>
  import('./features/credential-lifecycle/CredentialLifecyclePage').then((m) => ({
    default: m.CredentialLifecyclePage,
  })),
);
const NhiPage = React.lazy(() =>
  import('./features/nhi/NhiPage').then((m) => ({ default: m.NhiPage })),
);
const AccessExplorerPage = React.lazy(() =>
  import('./features/access-explorer/AccessExplorerPage').then((m) => ({
    default: m.AccessExplorerPage,
  })),
);
const SodPoliciesPage = React.lazy(() =>
  import('./features/sod-policies/SodPoliciesPage').then((m) => ({ default: m.SodPoliciesPage })),
);
const WebhooksPage = React.lazy(() =>
  import('./features/webhooks/WebhooksPage').then((m) => ({ default: m.WebhooksPage })),
);
const AdminUsersPage = React.lazy(() =>
  import('./features/admin-users/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage })),
);
const ReconciliationConfigPage = React.lazy(() =>
  import('./features/admin/ReconciliationConfig').then((m) => ({
    default: m.ReconciliationConfig,
  })),
);
const IdentityMapCanvas = React.lazy(() =>
  import('./features/identity-map/IdentityMapCanvas').then((m) => ({
    default: m.IdentityMapCanvas,
  })),
);

const PageSuspenseFallback = <Skeleton active paragraph={{ rows: 6 }} style={{ padding: 24 }} />;

/** Wraps page content with ErrorBoundary + page entry animation */
function PageWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <div className="page-enter">{children}</div>
    </ErrorBoundary>
  );
}

/** Activates real-time effects (notifications + query invalidation) */
const RealTimeEffects: React.FC = () => {
  useEventNotifications();
  useRealTimeQueryInvalidation();
  return null;
};

const isDevMode = import.meta.env.DEV && import.meta.env.VITE_AUTH_DISABLED === 'true';

const skipLinkStyle: React.CSSProperties = {
  position: 'absolute',
  left: '-9999px',
  top: 'auto',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
};

/** Custom layout: sidebar + (top bar | mobile header) + routed page */
const AppLayout: React.FC = () => {
  const screens = Grid.useBreakpoint();
  // Height of the sticky chrome above the page; canvas pages size against it.
  const chromeHeight = screens.md ? 48 : 56;
  return (
    <MobileMenuProvider>
      <Layout
        style={
          {
            minHeight: '100vh',
            '--euroid-chrome-height': `${chromeHeight}px`,
          } as React.CSSProperties
        }
      >
        <a
          href="#main-content"
          style={skipLinkStyle}
          onFocus={(e) => {
            e.currentTarget.style.position = 'static';
            e.currentTarget.style.width = 'auto';
            e.currentTarget.style.height = 'auto';
          }}
          onBlur={(e) => {
            e.currentTarget.style.position = 'absolute';
            e.currentTarget.style.left = '-9999px';
            e.currentTarget.style.width = '1px';
            e.currentTarget.style.height = '1px';
          }}
        >
          Skip to main content
        </a>
        <CommandPalette />
        <CustomSider />
        <Layout style={{ flexDirection: 'column', minWidth: 0 }}>
          <MobileHeader />
          <TopBar />
          <Content id="main-content" style={{ padding: 0, flex: 1, minWidth: 0 }}>
            <Outlet />
          </Content>
        </Layout>
      </Layout>
    </MobileMenuProvider>
  );
};

function ProtectedAppLayout() {
  const auth = useAuthContext();
  const navigate = useNavigate();
  const handleNotAuthenticated = () => {
    if (auth.signinRedirect) {
      const returnUrl = window.location.pathname + window.location.search || '/';
      setReturnUrl(returnUrl);
      auth.signinRedirect?.();
    } else {
      // The sign-in page goes here after a password or SAML sign-in (return-url-store.ts)
      setReturnUrl(window.location.pathname + window.location.search || '/');
      navigate('/login', { replace: true });
    }
  };
  return (
    <ProtectedRoute onNotAuthenticated={handleNotAuthenticated}>
      <MfaEnrollmentGate>
        <AppLayout />
      </MfaEnrollmentGate>
    </ProtectedRoute>
  );
}

const AuthWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const content = <SocketProvider>{children}</SocketProvider>;
  if (isDevMode) {
    return <DevAuthProvider>{content}</DevAuthProvider>;
  }
  if (import.meta.env.VITE_OIDC_AUTHORITY) {
    return (
      <AuthProvider {...oidcConfig}>
        <OIDCAuthBridge>{content}</OIDCAuthBridge>
      </AuthProvider>
    );
  }
  return <LocalAuthProvider>{content}</LocalAuthProvider>;
};

const NotFound = () => {
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title="404"
      subTitle="The page you are looking for does not exist."
      extra={
        <Button type="primary" onClick={() => navigate('/dashboard')}>
          Back to dashboard
        </Button>
      }
    />
  );
};

const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Router outermost: the auth providers navigate (e.g. to /login on logout). */}
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthWrapper>
          <ColorModeContextProvider>
            <AntdApp>
              <RealTimeEffects />
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/callback" element={<AuthCallback />} />
                <Route
                  path="/reset-password"
                  element={
                    <Suspense fallback={PageSuspenseFallback}>
                      <ResetPasswordPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/auth/saml-callback"
                  element={
                    <Suspense fallback={PageSuspenseFallback}>
                      <SamlCallbackPage />
                    </Suspense>
                  }
                />
                <Route element={<ProtectedAppLayout />}>
                  <Route index element={<Navigate to="/dashboard" replace />} />
                  <Route
                    path="/dashboard"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <DashboardPage />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/users"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <UserList />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/identities/:id"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <IdentityDetailPage />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/identity/:id/map"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <IdentityMapCanvas />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/blueprints"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <BlueprintCanvas />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/role-rules"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <RoleBasedRules />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/sod-policies"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <SodPoliciesPage />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/connectors"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <ConnectorMarketplace />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/reconciliation"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <ReconciliationDashboard />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/reconciliation/uncorrelated"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <UncorrelatedQueue />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  {/* Every bulk provisioning route needs operator */}
                  <Route
                    path="/bulk-operations"
                    element={
                      <ProtectedRoute requiredRole="operator">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <BulkOperations />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  {/* GET /nhi and GET /nhi/:agentId need viewer, which every role holds; the
                      super-admin actions are gated on the page. */}
                  <Route
                    path="/nhi"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <NhiPage />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  {/* Every GET of /access-explorer needs viewer, which every role holds; the
                      resync (super-admin) is gated on the page. */}
                  <Route
                    path="/access-explorer"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <AccessExplorerPage />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/audit"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <AuditDashboard />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/audit/integrity"
                    element={
                      <ProtectedRoute requiredRole="super-admin">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <AuditIntegrityPage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/compliance/reports"
                    element={
                      <ProtectedRoute requiredRole="policy-admin">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <ComplianceReports />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/compliance/gdpr"
                    element={
                      <ProtectedRoute requiredRole="operator">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <GdprPage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  {devToolsPages && (
                    <>
                      <Route
                        path="/dev/workflows"
                        element={
                          <ProtectedRoute requiredRole="super-admin">
                            <PageWrapper>
                              <Suspense fallback={PageSuspenseFallback}>
                                <devToolsPages.WorkflowDebugger />
                              </Suspense>
                            </PageWrapper>
                          </ProtectedRoute>
                        }
                      />
                      <Route
                        path="/dev/transactions"
                        element={
                          <ProtectedRoute requiredRole="super-admin">
                            <PageWrapper>
                              <Suspense fallback={PageSuspenseFallback}>
                                <devToolsPages.TransactionViewer />
                              </Suspense>
                            </PageWrapper>
                          </ProtectedRoute>
                        }
                      />
                    </>
                  )}
                  <Route
                    path="/intelligence/risk"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <RiskDashboard />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/intelligence/peer-groups"
                    element={
                      <ProtectedRoute requiredRole="policy-admin">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <PeerGroupsPage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/intelligence/role-rules"
                    element={<Navigate to="/role-rules" replace />}
                  />
                  <Route
                    path="/intelligence/suggestions"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <PolicySuggestions />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/intelligence/reviews"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <AccessReviews />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/intelligence/analytics"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <Analytics />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/intelligence/privileged-access"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <PrivilegedAccessDashboard />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/admin/scim"
                    element={
                      <ProtectedRoute requiredRole="super-admin">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <SCIMSettings />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/tenants"
                    element={
                      <ProtectedRoute>
                        {/* /tenants is the platform admin's, never a tenant role's. */}
                        <PlatformAdminRoute>
                          <PageWrapper>
                            <Suspense fallback={PageSuspenseFallback}>
                              <TenantManagement />
                            </Suspense>
                          </PageWrapper>
                        </PlatformAdminRoute>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/leavers"
                    element={
                      <ProtectedRoute requiredRole="policy-admin">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <LeaversPage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/dead-letter"
                    element={
                      <ProtectedRoute requiredRole="operator">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <DeadLetterPage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/credentials"
                    element={
                      <ProtectedRoute requiredRole="operator">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <CredentialLifecyclePage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/users"
                    element={
                      <ProtectedRoute requiredRole="super-admin">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <AdminUsersPage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/webhooks"
                    element={
                      <ProtectedRoute requiredRole="super-admin">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <WebhooksPage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/reconciliation-config"
                    element={
                      <ProtectedRoute requiredRole="policy-admin">
                        <PageWrapper>
                          <Suspense fallback={PageSuspenseFallback}>
                            <ReconciliationConfigPage />
                          </Suspense>
                        </PageWrapper>
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/access-requests"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <AccessRequestPortal />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/access-requests/approvals"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <AccessRequestPortal />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/access-requests/:id"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <RequestDetail />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route
                    path="/settings/security"
                    element={
                      <PageWrapper>
                        <Suspense fallback={PageSuspenseFallback}>
                          <AccountSecurityPage />
                        </Suspense>
                      </PageWrapper>
                    }
                  />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </AntdApp>
          </ColorModeContextProvider>
        </AuthWrapper>
      </BrowserRouter>
    </QueryClientProvider>
  );
};

export default App;
