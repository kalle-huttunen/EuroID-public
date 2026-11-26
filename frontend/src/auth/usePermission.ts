import { useAuthContext } from './auth-context';

const ROLE_HIERARCHY: Record<string, string[]> = {
  'super-admin': ['super-admin', 'connector-admin', 'policy-admin', 'operator', 'viewer'],
  'connector-admin': ['connector-admin', 'operator', 'viewer'],
  'policy-admin': ['policy-admin', 'operator', 'viewer'],
  operator: ['operator', 'viewer'],
  viewer: ['viewer'],
};

function hasPermission(userRoles: string[], requiredRole: string): boolean {
  return userRoles.some((role) => {
    const granted = ROLE_HIERARCHY[role] ?? [];
    return granted.includes(requiredRole);
  });
}

/**
 * Hook that checks if the current user has a given role, respecting the role hierarchy.
 * In dev mode (a development build with VITE_AUTH_DISABLED=true, as ProtectedRoute): always
 * returns true. A production build never skips the check.
 */
export function usePermission(requiredRole: string): boolean {
  const auth = useAuthContext();
  const isDevMode = import.meta.env.DEV && import.meta.env.VITE_AUTH_DISABLED === 'true';
  if (isDevMode) return true;

  const userRoles = (auth.user?.profile?.roles as string[] | undefined) ?? [];
  return hasPermission(userRoles, requiredRole);
}
