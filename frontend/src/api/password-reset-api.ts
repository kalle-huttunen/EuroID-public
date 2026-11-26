/**
 * Console admin password reset (backend `modules/auth/password-reset.controller.ts`). The request
 * and confirm routes are public; the code a super-admin issues is in admin-users-api.ts. The
 * reset token or code is never stored or logged here: it lives in the calling component's state.
 */
import { useQuery } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';

const RESET_API = `${API_BASE}/auth/password-reset`;

/** GET /auth/password-reset/config: whether a link can be mailed, and how long a token works. */
export interface PasswordResetConfig {
  byEmail: boolean;
  tokenTtlMinutes: number;
}

/** The deployment's reset options; without an answer, no mail is offered (a code still works). */
export function usePasswordResetConfig() {
  return useQuery({
    queryKey: ['password-reset', 'config'],
    queryFn: async () => {
      const { data } = await axiosInstance.get<PasswordResetConfig>(`${RESET_API}/config`);
      return data;
    },
    staleTime: Infinity,
  });
}

/** Asks for a link by email. The answer is the same whether or not the address has an account. */
export async function requestPasswordReset(email: string): Promise<{ message: string }> {
  const { data } = await axiosInstance.post<{ message: string }>(`${RESET_API}/request`, { email });
  return data;
}

/** Sets the new password with the token from the link or a super-admin's code. Signs nobody in. */
export async function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<{ success: boolean; message: string }> {
  const { data } = await axiosInstance.post<{ success: boolean; message: string }>(
    `${RESET_API}/confirm`,
    { token, newPassword },
  );
  return data;
}
