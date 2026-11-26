import React, { createContext, useContext, ReactNode } from 'react';

export interface AuthUserProfile {
  sub?: string;
  email?: string;
  name?: string;
  roles?: string[];
  tenantId?: string;
  tenantName?: string;
}

export interface AuthContextValue {
  user: {
    profile?: AuthUserProfile;
    access_token?: string;
  } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * The session is a sign-in's MFA enrollment token, which can only set up MFA
   * (auth/mfa-enrollment.ts): MfaEnrollmentGate shows MFA setup as the only page.
   */
  mfaEnrollmentOnly?: boolean;
  signoutRedirect?: () => void | Promise<void>;
  signinRedirect?: () => void | Promise<void>;
}

const defaultValue: AuthContextValue = {
  user: null,
  isAuthenticated: false,
  isLoading: true,
};

export const AuthContext = createContext<AuthContextValue>(defaultValue);

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  return ctx ?? defaultValue;
}
