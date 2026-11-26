import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spin, Result, Button } from 'antd';
import { useAuth } from 'react-oidc-context';
import { getSafeReturnUrl } from './auth-utils';
import { getReturnUrl, clearReturnUrl } from './return-url-store';

/**
 * Handles OIDC redirect callback after IdP login.
 * Shows loading spinner during token exchange, then redirects to / or the originally requested URL.
 * Handles token exchange errors gracefully with an error page.
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const auth = useAuth();

  useEffect(() => {
    if (auth.isLoading) return;
    if (auth.error) return;
    const stored = getReturnUrl();
    clearReturnUrl();
    const returnUrl = getSafeReturnUrl(stored, '/');
    navigate(returnUrl, { replace: true });
  }, [auth.isLoading, auth.error, navigate]);

  if (auth.error) {
    return (
      <Result
        status="error"
        title="Sign-in Failed"
        subTitle={auth.error.message || 'Token exchange failed. Please try again.'}
        extra={[
          <Button key="retry" type="primary" onClick={() => auth.signinRedirect()}>
            Try Again
          </Button>,
          <Button key="home" onClick={() => navigate('/')}>
            Go Home
          </Button>,
        ]}
      />
    );
  }

  return <Spin spinning fullscreen size="large" tip="Completing sign in..." />;
}
