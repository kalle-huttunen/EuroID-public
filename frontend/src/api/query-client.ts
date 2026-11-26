import { QueryClient } from '@tanstack/react-query';

/**
 * The one QueryClient of the console tab. A module of its own so the auth providers can clear
 * it when a session ends (auth/session-reset.ts) without needing the React provider.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});
