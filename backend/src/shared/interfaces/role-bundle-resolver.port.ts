/**
 * Port for resolving role bundles with inheritance.
 * Implemented by RoleBundlesService, injected via ROLE_BUNDLE_RESOLVER_PORT token.
 * Decouples consumers (PolicyEngineService) from RoleBundlesModule.
 */
export const ROLE_BUNDLE_RESOLVER_PORT = Symbol('ROLE_BUNDLE_RESOLVER_PORT');

/** Minimal action shape returned by role bundle resolution. */
export interface RoleBundleActionDto {
  id: string;
  type: string;
  target: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose Mixed type; shape varies per action type
  params?: Record<string, any>;
  label?: string;
  description?: string;
}

export interface IRoleBundleResolverPort {
  resolveWithInheritance(
    bundleId: string,
    tenantId?: string,
    maxDepth?: number,
  ): Promise<RoleBundleActionDto[]>;
}
