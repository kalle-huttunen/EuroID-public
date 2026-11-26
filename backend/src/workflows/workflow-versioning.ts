/**
 * Workflow versioning helpers.
 *
 * Temporal workflows replay their history on every run. Any non-additive change
 * (reordered activities, removed activities, changed signal/query signatures)
 * breaks replay for in-flight executions. The fix is `workflow.patched()`: it
 * lets old histories keep the old code path while new executions run the new
 * code path.
 *
 * Project convention for patch IDs:
 *   <workflow-name>:<change-summary>
 *
 * Examples:
 *   `onboarding:add-mfa-enrollment`
 *   `access-review:switch-reviewer-resolution`
 *
 * Remove a patch only after every workflow execution that started before the
 * change has completed (use `deprecatePatch` first, then remove).
 *
 * See: https://docs.temporal.io/develop/typescript/versioning
 */
import { patched as tsPatched, deprecatePatch as tsDeprecatePatch } from '@temporalio/workflow';

/** Branded patch identifier so typos can't slip through. */
export type PatchId = string & { readonly __patchIdBrand: unique symbol };

const PATCH_ID_RE = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

/** Validate a patch ID follows `<workflow>:<change>` kebab-case convention. */
export function patchId(id: string): PatchId {
  if (!PATCH_ID_RE.test(id)) {
    throw new Error(
      `Invalid patch ID "${id}". Expected kebab-case "<workflow>:<change>" (e.g. "onboarding:add-mfa-enrollment").`,
    );
  }
  return id as PatchId;
}

/**
 * Guard new workflow behavior behind a named patch. Returns `true` for
 * histories written with the patch present (new executions) and `false`
 * for older histories.
 *
 * Usage:
 * ```ts
 * if (isPatched('onboarding:add-mfa-enrollment')) {
 *   await enrollMfa(userId);
 * }
 * await createIdentity(userId);
 * ```
 */
export function isPatched(id: string): boolean {
  return tsPatched(patchId(id));
}

/**
 * Mark a patch as deprecated so newly-started workflows do not record it in
 * history. Keep this in place until every execution that might still hit the
 * old branch has completed; only then is it safe to remove the `if` guard.
 */
export function deprecatePatch(id: string): void {
  tsDeprecatePatch(patchId(id));
}
