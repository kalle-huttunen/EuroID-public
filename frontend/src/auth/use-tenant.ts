/**
 * Extract tenant context from auth. Works with both OIDC and Dev auth modes.
 */
import { useAuthContext } from "./auth-context";

export function useTenant(): {
  tenantId: string;
  tenantName: string;
  isLoaded: boolean;
} {
  const auth = useAuthContext();

  if (!auth.isAuthenticated || !auth.user) {
    return { tenantId: "", tenantName: "", isLoaded: false };
  }

  const tenantId = (auth.user.profile?.tenantId as string) ?? "";
  const tenantName = (auth.user.profile?.tenantName as string) ?? tenantId;

  return { tenantId, tenantName, isLoaded: true };
}
