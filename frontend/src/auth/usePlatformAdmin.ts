import { useQuery } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { useAuthContext } from './auth-context';

export const platformAdminKeys = {
  me: (sub: string | undefined) => ['auth', 'me', 'platform-admin', sub ?? null] as const,
};

/**
 * Whether the signed-in user is a platform admin, who alone may manage tenants (`/tenants`).
 * The backend decides it from PLATFORM_ADMIN_USER_IDS and reports it in GET /auth/me; no role,
 * token claim or dev mode on the client grants it. The UI only uses it to show or hide tenant
 * management: the API refuses everyone else (403) either way.
 */
export function usePlatformAdmin(): { isPlatformAdmin: boolean; isLoading: boolean } {
  const auth = useAuthContext();
  const sub = auth.user?.profile?.sub;
  const query = useQuery({
    // Per user: another sign-in in the same tab must not reuse the previous answer.
    queryKey: platformAdminKeys.me(sub),
    queryFn: async () => {
      const { data } = await axiosInstance.get<{ isPlatformAdmin?: boolean }>(
        `${API_BASE}/auth/me`,
      );
      return data?.isPlatformAdmin === true;
    },
    enabled: auth.isAuthenticated,
    // Granted by deployment configuration, which changes only with an API restart.
    staleTime: Infinity,
  });
  return {
    isPlatformAdmin: query.data === true,
    isLoading: auth.isLoading || (auth.isAuthenticated && query.isPending),
  };
}
