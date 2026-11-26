/**
 * The identity page's route: `/identities/:id`, the open tab in `?tab=` (Profile when absent).
 */

export const IDENTITY_TABS = [
  'profile',
  'access',
  'recommendations',
  'drift',
  'credentials',
  'timeline',
  'risk',
  'raw',
] as const;
export type IdentityTab = (typeof IDENTITY_TABS)[number];

/** Path of an identity's page, optionally on a tab. */
export function identityPath(id: string, tab?: IdentityTab): string {
  const path = `/identities/${encodeURIComponent(id)}`;
  return tab && tab !== 'profile' ? `${path}?tab=${tab}` : path;
}
