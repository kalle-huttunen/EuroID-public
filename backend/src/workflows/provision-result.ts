/**
 * Reading a target's provision answer (onboarding and admin account provisioning). A provision
 * activity can answer without throwing and without having done its work: provisionUserToAd
 * answers `{ success: false, skipped: true, error }` when its config lacks a host or a base DN.
 * Such a target was not provisioned, so it must not become SYNCED.
 *
 * Workflow code: bundled into the workflows, so it must stay deterministic (pure functions).
 */

/** The part of a provision activity's answer read here. */
export interface ProvisionAnswer {
  success?: boolean;
  error?: unknown;
}

/** Said of a target that answered `success: false` without a reason of its own. */
const NO_REASON = 'the target answered that it did not provision the account';

/**
 * The reason a provision that answered `success: false` gives (its `error`, else a generic one);
 * undefined for any other answer, a missing one included (older connectors return nothing).
 */
export function unprovisionedReason(answer: ProvisionAnswer | undefined): string | undefined {
  if (answer?.success !== false) return undefined;
  return typeof answer.error === 'string' && answer.error.trim() ? answer.error : NO_REASON;
}

/** The run's result with each target that did not provision named, with its reason, once. */
export function withNotProvisioned(result: string, notProvisioned: Iterable<string>): string {
  const entries = [...new Set(notProvisioned)];
  return entries.reduce((text, entry) => `${text} Not provisioned to ${entry}.`, result);
}
