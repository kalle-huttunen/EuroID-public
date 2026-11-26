/**
 * OIDC configuration for IdP-agnostic authentication (Entra ID, Auth0, Keycloak, etc.).
 * Uses VITE_ env vars - all must be prefixed for Vite to expose them.
 */
export const oidcConfig = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY || '',
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID || '',
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: window.location.origin,
  scope: 'openid profile email',
  response_type: 'code',
  automaticSilentRenew: true,
};
