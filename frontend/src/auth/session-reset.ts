import { queryClient } from '@api/query-client';
import { useConnectorStore } from '@stores/connector-store';
import { usePolicyDraftStore } from '@stores/policy-draft-store';

/**
 * Drops what the console keeps of the signed-in user in this tab: the query cache (most keys
 * carry no user or tenant, so the next user signing in without a reload would see these rows),
 * the installed connector list and the Design studio draft. Every auth provider calls it when a
 * session ends, before it navigates away.
 */
export function clearSessionState(): void {
  queryClient.clear();
  useConnectorStore.getState().clearOnLogout();
  usePolicyDraftStore.getState().reset();
}
